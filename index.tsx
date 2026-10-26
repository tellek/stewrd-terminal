/// <reference path="../.stewrd/plugin-api.d.ts" />
import { useEffect, useReducer, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import xtermCss from "@xterm/xterm/css/xterm.css";
import type { PluginContext, PluginApi, StatusColor as HostStatusColor } from "stewrd-plugin-api";
import { ptySpawn, ptyWrite, ptyResize, ptyKill, ptyAck, onPtyOutput, onPtyExit } from "./src/pty";
import { pickShell, type ShellLaunch } from "./src/shellIntegration";
import { createAckBatcher, type AckBatcher } from "./src/ackBatcher";
import { createInputCoalescer, type InputCoalescer } from "./src/inputCoalescer";
import { parseWindowsBuild } from "./src/hostCompat";
import { StatusTracker, SUCCESS_MS, worstStatus, type StatusColor } from "./src/statusTracker";
import { createQuietTimer, type QuietTimer } from "./src/quietTimer";
import { toXtermTheme } from "./src/xtermTheme";

interface Session {
  id: string;
  term: Terminal;
  fitAddon: FitAddon;
  tracker: StatusTracker;
  hostDiv: HTMLDivElement;
  opened: boolean;
  exited: boolean;
  disposed: boolean;
  // True while the plugin is mounted in a pane; the success dot only counts
  // down while this and the window both have focus.
  visible: boolean;
  // Last state rendered by the in-pane dot, to re-render only on change.
  shownState: StatusColor;
  successTimer: ReturnType<typeof setTimeout> | null;
  quietTimer: QuietTimer;
  // Last size actually sent to the PTY (ptySpawn starts at 80x24), so resizes
  // are deduped against what the shell knows, not against xterm's own size.
  ptyCols: number;
  ptyRows: number;
  // The shell is spawned on the first fit (not at creation) so it starts at the
  // pane's real size instead of 80x24 and repaints its prompt only once.
  shell: ShellLaunch;
  spawnPromise?: Promise<void>;
  onOutput: (chunk: string | Uint8Array) => void;
  acks: AckBatcher;
  input: InputCoalescer;
  webglRetries: number;
  unlistenOutput?: () => void;
  unlistenExit?: () => void;
  unsubscribeTheme?: () => void;
}

const QUIET_MS = 700;
const NO_PANE_ID = "__no-pane-id__";

// Sessions are keyed by pane id (the host-provided `paneId` prop), not by
// Session.id, so a plugin placed in N panes at once gets N independent
// shells that each survive that pane's own remounts (tool-switch-away/back,
// a Settings visit, a pane split/close) instead of fighting over one global
// terminal. See the plan doc for why sessions are only ever torn down in
// ctx.onDispose, never on a Component unmount.
const sessions = new Map<string, Session>();
// In-flight session creations, keyed by paneId, so a mount racing a
// restart (or React StrictMode's dev double-invoke) can't spawn two shells
// for the same pane.
const pending = new Map<string, Promise<Session>>();
let activeCtx: PluginContext | null = null;
const sessionListeners = new Set<() => void>();

function injectXtermCssOnce() {
  if (document.getElementById("stewrd-terminal-xterm-css")) return;
  const style = document.createElement("style");
  style.id = "stewrd-terminal-xterm-css";
  style.textContent = xtermCss;
  document.head.appendChild(style);
}

function notifySessionChanged() {
  sessionListeners.forEach((fn) => fn());
}

// The sidebar icon is plugin-wide, so it shows the worst state across every
// pane's session (error > warning > in-progress > success > idle).
function applyStatus(api: PluginApi, ctx: PluginContext) {
  if (ctx.signal.aborted) return;
  const color = worstStatus([...sessions.values()].map((x) => x.tracker.getState()));
  try {
    // Dedupe against the host's current value; this runs on every output chunk.
    if (api.statusIcon.get() !== color) api.statusIcon.set(color);
  } catch {
    // thrown after hot-reload/deactivation - safe to ignore
  }
}

// success lingers SUCCESS_MS, counted only while the app and this plugin are
// focused, so a success finished in the background stays until the user returns.
function syncSuccessTimer(api: PluginApi, ctx: PluginContext, s: Session) {
  const counting = s.tracker.getState() === "success" && s.visible && document.hasFocus();
  if (!counting) {
    if (s.successTimer) clearTimeout(s.successTimer);
    s.successTimer = null;
    return;
  }
  if (s.successTimer) return;
  s.successTimer = setTimeout(() => {
    s.successTimer = null;
    if (ctx.signal.aborted || s.disposed) return;
    s.tracker.onSuccessElapsed();
    updateStatus(api, ctx, s);
  }, SUCCESS_MS);
}

function updateStatus(api: PluginApi, ctx: PluginContext, s: Session) {
  syncSuccessTimer(api, ctx, s);
  applyStatus(api, ctx);
  const state = s.tracker.getState();
  if (state !== s.shownState) {
    s.shownState = state;
    notifySessionChanged();
  }
}

function lastNonBlankLine(s: Session): string {
  const buf = s.term.buffer.active;
  for (let i = buf.cursorY; i >= 0; i--) {
    const line = buf.getLine(i);
    const text = line ? line.translateToString(true) : "";
    if (text.trim()) return text;
  }
  return "";
}

// data is the OSC 133 payload, e.g. "D", "D;0", "D;1", or "A" (not a done marker).
function parseCommandDoneMarker(data: string): 0 | 1 | null | undefined {
  if (data === "D") return null;
  if (data === "D;0") return 0;
  if (data === "D;1") return 1;
  return undefined;
}

// Resolved once; xterm's ConPTY-aware resize/reflow handling needs the OS build
// number, and a wrong or low value would disable reflow, so leave it unset if
// it can't be determined.
let windowsBuildPromise: Promise<number | undefined> | null = null;
function getWindowsBuild(api: PluginApi): Promise<number | undefined> {
  windowsBuildPromise ??= api.shell
    .exec("cmd", ["/c", "ver"])
    .then((r) => parseWindowsBuild(r.stdout))
    .catch(() => undefined);
  return windowsBuildPromise;
}

async function startSession(api: PluginApi, ctx: PluginContext): Promise<Session> {
  const term = new Terminal({ theme: toXtermTheme(api.theme.palette), cursorBlink: true, fontSize: 13 });
  getWindowsBuild(api).then((buildNumber) => {
    if (buildNumber) term.options.windowsPty = { backend: "conpty", buildNumber };
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const hostDiv = document.createElement("div");
  hostDiv.style.width = "100%";
  hostDiv.style.height = "100%";

  const tracker = new StatusTracker();
  const s: Session = {
    id: crypto.randomUUID(),
    term,
    fitAddon,
    tracker,
    hostDiv,
    opened: false,
    exited: false,
    disposed: false,
    visible: false,
    shownState: "idle",
    successTimer: null,
    quietTimer: createQuietTimer(QUIET_MS, () => {
      if (ctx.signal.aborted || s.disposed) return;
      tracker.onQuiet(lastNonBlankLine(s));
      updateStatus(api, ctx, s);
    }),
    ptyCols: 80,
    ptyRows: 24,
    shell: undefined as unknown as ShellLaunch, // set below, before the session is returned
    onOutput: () => {}, // replaced below
    acks: createAckBatcher((n) => {
      if (!s.disposed) ptyAck(s.id, n).catch(() => {});
    }),
    // Waits for the spawn so early input (incl. xterm's cursor-report reply)
    // can't hit an unknown session id.
    input: createInputCoalescer(
      (data) => (s.spawnPromise ?? Promise.resolve()).then(() => ptyWrite(s.id, data)),
      (err) => api.log.error(`pty write failed: ${err}`),
    ),
    webglRetries: 0,
  };

  term.parser.registerOscHandler(133, (data: string) => {
    const exitFlag = parseCommandDoneMarker(data);
    if (exitFlag !== undefined) {
      tracker.onCommandDone(exitFlag);
      updateStatus(api, ctx, s);
    }
    return true;
  });

  term.onData((data) => {
    s.input.push(data);
    // onInput only reacts to Enter, so skip the status work for other keys.
    if (data.includes("\r") || data.includes("\n")) {
      tracker.onInput(data);
      updateStatus(api, ctx, s);
    }
  });

  // Binary chunks come from the flow-controlled channel (pty_spawn_v2); string
  // chunks from the "pty-output" event on a host that predates it.
  const onOutput = (chunk: string | Uint8Array) => {
    if (ctx.signal.aborted || s.disposed) return;
    if (typeof chunk === "string") term.write(chunk);
    else term.write(chunk, s.acks.track(chunk.byteLength));
    const before = tracker.getState();
    if (tracker.onOutput() !== before) updateStatus(api, ctx, s);
    s.quietTimer.touch();
  };
  s.onOutput = onOutput;

  const [outputRes, exitRes, shellRes] = await Promise.allSettled([
    onPtyOutput(s.id, onOutput),
    onPtyExit(s.id, (code) => {
      s.exited = true;
      api.log.info(`terminal shell exited (code ${code})`);
      notifySessionChanged();
    }),
    pickShell(api),
  ]);
  const unlistenOutput = outputRes.status === "fulfilled" ? outputRes.value : undefined;
  const unlistenExit = exitRes.status === "fulfilled" ? exitRes.value : undefined;
  const failure = [outputRes, exitRes, shellRes].find((r) => r.status === "rejected");
  if (failure || ctx.signal.aborted) {
    unlistenOutput?.();
    unlistenExit?.();
    if (failure) throw (failure as PromiseRejectedResult).reason;
    return s;
  }
  s.unlistenOutput = unlistenOutput;
  s.unlistenExit = unlistenExit;

  s.shell = (shellRes as PromiseFulfilledResult<ShellLaunch>).value;

  s.unsubscribeTheme = api.theme.subscribe((palette) => {
    term.options.theme = toXtermTheme(palette);
  });

  return s;
}

// WebGL is far faster than the DOM renderer for heavy output; if it can't load
// (no WebGL2, GPU blocklist) xterm keeps the DOM renderer. After a GPU context
// loss it is recreated, at most twice, since each pane holds its own context.
function attachWebgl(s: Session) {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      if (s.disposed || s.webglRetries >= 2) return;
      s.webglRetries++;
      setTimeout(() => {
        if (!s.disposed) attachWebgl(s);
      }, 1000 * s.webglRetries);
    });
    s.term.loadAddon(webgl);
  } catch {
    // fall back to the DOM renderer
  }
}

// Spawns the shell once, at the term's current (fitted) size. Idempotent, and a
// no-op after teardown so a late first fit can't start a shell nobody kills.
function spawnSession(api: PluginApi, ctx: PluginContext, s: Session) {
  if (s.spawnPromise || s.disposed || ctx.signal.aborted) return;
  s.ptyCols = s.term.cols;
  s.ptyRows = s.term.rows;
  s.spawnPromise = ptySpawn(
    { id: s.id, program: s.shell.program, args: s.shell.args, cols: s.ptyCols, rows: s.ptyRows },
    s.onOutput,
  )
    .then(() => {})
    .catch((err) => {
      api.log.error(`failed to spawn terminal: ${err}`);
      s.exited = true;
      s.tracker.onFatal();
      if (!ctx.signal.aborted && !s.disposed) {
        updateStatus(api, ctx, s);
        notifySessionChanged();
      }
    });
}

async function teardownSession(s: Session) {
  s.disposed = true;
  s.unlistenOutput?.();
  s.unlistenExit?.();
  s.quietTimer.cancel();
  if (s.successTimer) clearTimeout(s.successTimer);
  s.unsubscribeTheme?.();
  s.term.dispose();
  // term.dispose() only clears xterm's own contents from inside hostDiv, it
  // doesn't remove hostDiv itself - without this, a torn-down session's now
  // empty hostDiv is left behind in the pane's container.
  s.hostDiv.remove();
  // A spawn may still be in flight; kill only after it lands, otherwise the
  // kill hits an unknown id and the shell is orphaned.
  await s.spawnPromise;
  await ptyKill(s.id).catch(() => {});
}

// Shared by the Component's mount effect and restartSession, so session
// creation (and the pending/sessions bookkeeping around it) lives in exactly
// one place. Reuses any existing, non-disposed session for this paneId -
// deliberately including an already-exited one, since a plain remount
// (switching tools away and back, or an intervening Settings visit) must not
// silently discard an exited shell's banner/scrollback out from under the
// user. Only restartSession is allowed to replace an exited session.
function getOrCreateSession(api: PluginApi, ctx: PluginContext, paneId: string): Promise<Session> {
  const existing = sessions.get(paneId);
  if (existing && !existing.disposed) return Promise.resolve(existing);

  const inFlight = pending.get(paneId);
  if (inFlight) return inFlight;

  const p = startSession(api, ctx)
    .then((s) => {
      if (ctx.signal.aborted) {
        teardownSession(s);
        return s;
      }
      sessions.set(paneId, s);
      applyStatus(api, ctx);
      return s;
    })
    .finally(() => {
      pending.delete(paneId);
    });
  pending.set(paneId, p);
  return p;
}

export function activate(ctx: PluginContext) {
  injectXtermCssOnce();
  ctx.api.statusIcon.set("idle");
  activeCtx = ctx;

  ctx.onDispose(() => {
    if (activeCtx === ctx) activeCtx = null;
    const toTeardown = [...sessions.values()];
    sessions.clear();
    pending.clear();
    toTeardown.forEach((s) => teardownSession(s));
  });
}

export function deactivate() {}

async function restartSession(paneId: string): Promise<Session> {
  const ctx = activeCtx;
  if (!ctx) throw new Error("terminal plugin is not active");
  const old = sessions.get(paneId);
  sessions.delete(paneId);
  if (old) await teardownSession(old);
  applyStatus(ctx.api, ctx);
  return getOrCreateSession(ctx.api, ctx, paneId);
}

export function Component({ api, paneId }: { api: PluginApi; paneId?: string }) {
  const key = paneId ?? NO_PANE_ID;
  const [session, setSession] = useState<Session | null>(null);
  const mountedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    sessionListeners.add(forceUpdate as unknown as () => void);
    return () => {
      sessionListeners.delete(forceUpdate as unknown as () => void);
    };
  }, []);

  useEffect(() => {
    // Re-armed here (not just at declaration) because React.StrictMode's dev
    // double-invoke runs this effect, then its cleanup, then this effect
    // again - without re-arming, mountedRef would stay false forever after
    // that synthetic remount, permanently blocking setSession in dev builds.
    mountedRef.current = true;
    const ctx = activeCtx;
    if (ctx) {
      getOrCreateSession(api, ctx, key)
        .then((s) => {
          if (mountedRef.current && !s.disposed) setSession(s);
        })
        .catch((err) => api.log.error(`terminal activation failed: ${err}`));
    }
    return () => {
      mountedRef.current = false;
    };
  }, [api, key]);

  useEffect(() => {
    const container = containerRef.current;
    const s = session;
    if (!container || !s) return;

    if (!container.contains(s.hostDiv)) {
      container.appendChild(s.hostDiv);
    }

    const wasOpened = s.opened;
    if (!wasOpened) {
      s.term.open(s.hostDiv);
      s.opened = true;
      attachWebgl(s);
    }

    // ConPTY reflows and the shell redraws on every resize, so PTY resizes are
    // trailing-debounced and deduped against the size the shell already has.
    // xterm itself still fits every frame so the pane never looks stretched.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const sendResize = () => {
      const { cols, rows } = s.term;
      if (s.disposed || (cols === s.ptyCols && rows === s.ptyRows)) return;
      s.ptyCols = cols;
      s.ptyRows = rows;
      ptyResize(s.id, cols, rows).catch(() => {});
    };
    const doFit = () => {
      s.fitAddon.fit();
      if (!s.spawnPromise) {
        // First fit: spawn at the real size (whatever it is) instead of resizing later.
        if (activeCtx) spawnSession(api, activeCtx, s);
        return;
      }
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendResize, 100);
    };
    doFit();
    if (wasOpened) s.term.refresh(0, s.term.rows - 1);

    // Deferred to the next frame: calling doFit() synchronously from inside
    // the ResizeObserver callback resizes the observed element again in the
    // same pass, which trips the browser's benign-but-noisy "ResizeObserver
    // loop completed with undelivered notifications" warning.
    let rafId = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(doFit);
    });
    ro.observe(container);

    // Focus acknowledges an error and (re)starts the success countdown; blur
    // pauses the countdown so a success finished in the background stays put.
    s.visible = true;
    const onFocusLike = () => {
      if (!activeCtx) return;
      s.tracker.onFocus();
      updateStatus(api, activeCtx, s);
    };
    const onWindowFocusChange = () => {
      if (activeCtx) syncSuccessTimer(api, activeCtx, s);
    };
    container.addEventListener("pointerdown", onFocusLike);
    window.addEventListener("focus", onFocusLike);
    window.addEventListener("blur", onWindowFocusChange);
    onFocusLike();

    return () => {
      s.visible = false;
      if (activeCtx) syncSuccessTimer(api, activeCtx, s);
      window.removeEventListener("focus", onFocusLike);
      window.removeEventListener("blur", onWindowFocusChange);
      ro.disconnect();
      cancelAnimationFrame(rafId);
      clearTimeout(resizeTimer);
      container.removeEventListener("pointerdown", onFocusLike);
    };
  }, [api, session]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {session?.exited && <api.ui.Banner message="The Terminal Shell Has Exited" tone="warning" />}
      {session?.exited && (
        <div style={{ marginBottom: 8 }}>
          <api.ui.TextButton
            label="Restart Terminal"
            variant="primary"
            onClick={() => {
              restartSession(key).then((s) => {
                if (mountedRef.current) setSession(s);
              });
            }}
          />
        </div>
      )}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
