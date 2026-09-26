/// <reference path="../.stewrd/plugin-api.d.ts" />
import { useEffect, useReducer, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import xtermCss from "@xterm/xterm/css/xterm.css";
import type { PluginContext, PluginApi, StatusColor as HostStatusColor } from "stewrd-plugin-api";
import { ptySpawn, ptyWrite, ptyResize, ptyKill, onPtyOutput, onPtyExit } from "./src/pty";
import { pickShell } from "./src/shellIntegration";
import { StatusTracker } from "./src/statusTracker";
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
  quietTimer: ReturnType<typeof setTimeout> | null;
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
    api.statusIcon.set(color);
  } catch {
    // thrown after hot-reload/deactivation - safe to ignore
  }
}

function scheduleQuietCheck(api: PluginApi, ctx: PluginContext, s: Session) {
  if (s.quietTimer) clearTimeout(s.quietTimer);
  s.quietTimer = setTimeout(() => {
    if (ctx.signal.aborted || s.disposed) return;
    const buf = s.term.buffer.active;
    let lastLine = "";
    for (let i = buf.cursorY; i >= 0; i--) {
      const line = buf.getLine(i);
      const text = line ? line.translateToString(true) : "";
      if (text.trim()) {
        lastLine = text;
        break;
      }
    }
    const next = s.tracker.onQuiet(lastLine);
    applyStatus(api, ctx, next);
  }, QUIET_MS);
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
    quietTimer: null,
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

  const unlistenOutput = await onPtyOutput(s.id, (chunk) => {
    if (ctx.signal.aborted) return;
    term.write(chunk);
    const next = tracker.onOutput();
    applyStatus(api, ctx, next);
    scheduleQuietCheck(api, ctx, s);
  });
  if (ctx.signal.aborted) {
    unlistenOutput();
    return s;
  }
  s.unlistenOutput = unlistenOutput;

  const unlistenExit = await onPtyExit(s.id, (code) => {
    s.exited = true;
    api.log.info(`terminal shell exited (code ${code})`);
    notifySessionChanged();
  });
  if (ctx.signal.aborted) {
    unlistenExit();
    return s;
  }
  s.unlistenExit = unlistenExit;

  const shell = await pickShell(api);
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
  if (s.quietTimer) clearTimeout(s.quietTimer);
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
    } else {
      s.fitAddon.fit();
      s.term.refresh(0, s.term.rows - 1);
    }

    const doFit = () => {
      s.fitAddon.fit();
      ptyResize(s.id, s.term.cols, s.term.rows).catch(() => {});
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
      const next = s.tracker.onFocus();
      try {
        api.statusIcon.set(next);
      } catch {
        // thrown after hot-reload/deactivation - safe to ignore
      }
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
