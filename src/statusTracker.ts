export type StatusColor = "idle" | "in-progress" | "success" | "warning" | "error";

const QUESTION_PATTERNS: RegExp[] = [
  /\?\s*$/,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /:\s*$/,
  /password/i,
  /press any key/i,
];

export function looksLikeQuestion(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return QUESTION_PATTERNS.some((re) => re.test(trimmed));
}

// Pure state machine driving the sidebar status icon. No DOM/xterm
// dependency so it can be unit tested directly.
export class StatusTracker {
  private current: StatusColor = "idle";
  private preEnterState: StatusColor = "idle";

  getState(): StatusColor {
    return this.current;
  }

  onInput(data: string): StatusColor {
    const pressedEnter = data.includes("\r") || data.includes("\n");
    if (pressedEnter && (this.current === "idle" || this.current === "success" || this.current === "error")) {
      this.preEnterState = this.current;
      this.current = "in-progress";
    }
    return this.current;
  }

  onOutput(): StatusColor {
    if (this.current === "warning") {
      this.current = "in-progress";
    }
    return this.current;
  }

  // exitFlag: 0 or 1 for a command that ran, null for a bare "D" marker
  // (no command ran - empty Enter or Ctrl+C).
  onCommandDone(exitFlag: 0 | 1 | null): StatusColor {
    if (this.current !== "in-progress" && this.current !== "warning") {
      return this.current;
    }
    if (exitFlag === null) {
      this.current = this.preEnterState;
    } else if (exitFlag === 1) {
      this.current = "error";
    } else {
      this.current = "success";
    }
    return this.current;
  }

  onQuiet(lastLine: string): StatusColor {
    if (this.current === "in-progress" && looksLikeQuestion(lastLine)) {
      this.current = "warning";
    }
    return this.current;
  }

  // Focus acknowledges an error; success is NOT cleared here, it lingers for
  // SUCCESS_MS of focused time (see onSuccessElapsed).
  onFocus(): StatusColor {
    if (this.current === "error") {
      this.current = "idle";
    }
    return this.current;
  }

  // The success dot is shown for SUCCESS_MS while the app and plugin have focus.
  onSuccessElapsed(): StatusColor {
    if (this.current === "success") {
      this.current = "idle";
    }
    return this.current;
  }

  // A failure outside the command flow (e.g. the shell failed to spawn).
  onFatal(): StatusColor {
    this.current = "error";
    return this.current;
  }
}

export const SUCCESS_MS = 3000;

// Highest-priority color wins: error > warning > in-progress > success > idle.
const PRIORITY: StatusColor[] = ["idle", "success", "in-progress", "warning", "error"];

export function worstStatus(states: StatusColor[]): StatusColor {
  return states.reduce<StatusColor>((w, s) => (PRIORITY.indexOf(s) > PRIORITY.indexOf(w) ? s : w), "idle");
}
