/// <reference path="../.stewrd/plugin-api.d.ts" />
import { useEffect, useReducer, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import xtermCss from "@xterm/xterm/css/xterm.css";
import type { PluginContext, PluginApi, StatusColor as HostStatusColor } from "stewrd-plugin-api";
import { ptySpawn, ptyWrite, ptyResize, ptyKill, onPtyOutput, onPtyExit } from "./src/pty";
import { pickShell } from "./src/shellIntegration";
import { StatusTracker } from "./src/statusTracker";
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
  quietTimer: QuietTimer;
  // Last size actually sent to the PTY (ptySpawn starts at 80x24), so resizes
  // are deduped against what the shell knows, not against xterm's own size.
  ptyCols: number;
  ptyRows: number;
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

function applyStatus(api: PluginApi, ctx: PluginContext, color: HostStatusColor) {
  if (ctx.signal.aborted) return;
  try {
    // The icon is plugin-wide (shared by every pane), so dedupe against the
    // host's current value; this runs on every output chunk.
    if (api.statusIcon.get() !== color) api.statusIcon.set(color);
  } catch {
    // thrown after hot-reload/deactivation - safe to ignore
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

async function startSession(api: PluginApi, ctx: PluginContext): Promise<Session> {
  const term = new Terminal({ theme: toXtermTheme(api.theme.palette), cursorBlink: true, fontSize: 13 });
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
    quietTimer: createQuietTimer(QUIET_MS, () => {
      if (ctx.signal.aborted || s.disposed) return;
      applyStatus(api, ctx, tracker.onQuiet(lastNonBlankLine(s)));
    }),
    ptyCols: 80,
    ptyRows: 24,
  };

  term.parser.registerOscHandler(133, (data: string) => {
    const exitFlag = parseCommandDoneMarker(data);
    if (exitFlag !== undefined) {
      const next = tracker.onCommandDone(exitFlag);
      applyStatus(api, ctx, next);
    }
    return true;
  });

  term.onData((data) => {
    const next = tracker.onInput(data);
    applyStatus(api, ctx, next);
    ptyWrite(s.id, data).catch((err) => api.log.error(`pty write failed: ${err}`));
  });

  const [outputRes, exitRes, shellRes] = await Promise.allSettled([
    onPtyOutput(s.id, (chunk) => {
      if (ctx.signal.aborted) return;
      term.write(chunk);
      applyStatus(api, ctx, tracker.onOutput());
      s.quietTimer.touch();
    }),
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

  const shell = (shellRes as PromiseFulfilledResult<Awaited<ReturnType<typeof pickShell>>>).value;
  try {
    await ptySpawn({ id: s.id, program: shell.program, args: shell.args, cols: 80, rows: 24 });
  } catch (err) {
    api.log.error(`failed to spawn terminal: ${err}`);
    s.exited = true;
    applyStatus(api, ctx, "error");
  }

  s.unsubscribeTheme = api.theme.subscribe((palette) => {
    term.options.theme = toXtermTheme(palette);
  });

  return s;
}

async function teardownSession(s: Session) {
  s.unlistenOutput?.();
  s.unlistenExit?.();
  s.quietTimer.cancel();
  s.unsubscribeTheme?.();
  s.term.dispose();
  // term.dispose() only clears xterm's own contents from inside hostDiv, it
  // doesn't remove hostDiv itself - without this, a torn-down session's now
  // empty hostDiv is left behind in the pane's container.
  s.hostDiv.remove();
  s.disposed = true;
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

    if (!s.opened) {
      s.term.open(s.hostDiv);
      s.opened = true;
      // WebGL is far faster than the DOM renderer for heavy output; if it
      // can't load (no WebGL2, GPU blocklist) xterm keeps the DOM renderer.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        s.term.loadAddon(webgl);
      } catch {
        // fall back to the DOM renderer
      }
    } else {
      s.fitAddon.fit();
      s.term.refresh(0, s.term.rows - 1);
    }

    const doFit = () => {
      s.fitAddon.fit();
      const { cols, rows } = s.term;
      if (cols === s.ptyCols && rows === s.ptyRows) return;
      s.ptyCols = cols;
      s.ptyRows = rows;
      ptyResize(s.id, cols, rows).catch(() => {});
    };
    doFit();

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

    const onFocusLike = () => {
      if (activeCtx) applyStatus(api, activeCtx, s.tracker.onFocus());
    };
    container.addEventListener("pointerdown", onFocusLike);
    onFocusLike();

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafId);
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
