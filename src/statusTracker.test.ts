import { describe, it, expect } from "vitest";
import { StatusTracker, looksLikeQuestion, worstStatus } from "./statusTracker";

describe("looksLikeQuestion", () => {
  it("detects question marks, y/n prompts, trailing colons, password/key prompts", () => {
    expect(looksLikeQuestion("Continue?")).toBe(true);
    expect(looksLikeQuestion("Overwrite (y/n)")).toBe(true);
    expect(looksLikeQuestion("Proceed [Y/n]")).toBe(true);
    expect(looksLikeQuestion("Enter name:")).toBe(true);
    expect(looksLikeQuestion("Password:")).toBe(true);
    expect(looksLikeQuestion("Press any key to continue")).toBe(true);
    expect(looksLikeQuestion("hello world")).toBe(false);
    expect(looksLikeQuestion("")).toBe(false);
  });
});

describe("StatusTracker", () => {
  it("starts idle", () => {
    expect(new StatusTracker().getState()).toBe("idle");
  });

  it("Enter while idle goes in-progress", () => {
    const t = new StatusTracker();
    expect(t.onInput("\r")).toBe("in-progress");
  });

  it("Enter while success/error also goes in-progress", () => {
    const success = new StatusTracker();
    success.onInput("\r");
    success.onCommandDone(0);
    expect(success.getState()).toBe("success");
    expect(success.onInput("\r")).toBe("in-progress");

    const error = new StatusTracker();
    error.onInput("\r");
    error.onCommandDone(1);
    expect(error.getState()).toBe("error");
    expect(error.onInput("\r")).toBe("in-progress");
  });

  it("a D marker while idle is ignored (startup prompt)", () => {
    const t = new StatusTracker();
    expect(t.onCommandDone(0)).toBe("idle");
    expect(t.onCommandDone(null)).toBe("idle");
  });

  it("exit code 0 goes success, exit code 1 goes error", () => {
    const t = new StatusTracker();
    t.onInput("\r");
    expect(t.onCommandDone(0)).toBe("success");

    const t2 = new StatusTracker();
    t2.onInput("\r");
    expect(t2.onCommandDone(1)).toBe("error");
  });

  it("a bare D (no command ran) restores the state from before Enter", () => {
    const idle = new StatusTracker();
    idle.onInput("\r");
    expect(idle.onCommandDone(null)).toBe("idle");

    const error = new StatusTracker();
    error.onInput("\r");
    error.onCommandDone(1);
    expect(error.getState()).toBe("error");
    error.onInput("\r"); // empty Enter again
    expect(error.onCommandDone(null)).toBe("error");
  });

  it("D after warning resolves the warning", () => {
    const t = new StatusTracker();
    t.onInput("\r");
    t.onQuiet("Overwrite (y/n)?");
    expect(t.getState()).toBe("warning");
    expect(t.onCommandDone(0)).toBe("success");
  });

  it("output while warning returns to in-progress", () => {
    const t = new StatusTracker();
    t.onInput("\r");
    t.onQuiet("Continue?");
    expect(t.getState()).toBe("warning");
    expect(t.onOutput()).toBe("in-progress");
  });

  it("quiet output only becomes a warning while in-progress", () => {
    const t = new StatusTracker();
    expect(t.onQuiet("Continue?")).toBe("idle");
  });

  it("quiet output that doesn't look like a question stays in-progress", () => {
    const t = new StatusTracker();
    t.onInput("\r");
    expect(t.onQuiet("still working...")).toBe("in-progress");
  });

  it("onFocus clears error to idle but leaves success/in-progress/warning alone", () => {
    const success = new StatusTracker();
    success.onInput("\r");
    success.onCommandDone(0);
    expect(success.onFocus()).toBe("success");

    const error = new StatusTracker();
    error.onInput("\r");
    error.onCommandDone(1);
    expect(error.onFocus()).toBe("idle");

    const running = new StatusTracker();
    running.onInput("\r");
    expect(running.onFocus()).toBe("in-progress");

    const warning = new StatusTracker();
    warning.onInput("\r");
    warning.onQuiet("Continue?");
    expect(warning.onFocus()).toBe("warning");
  });

  it("onSuccessElapsed returns success to idle and leaves other states alone", () => {
    const success = new StatusTracker();
    success.onInput("\r");
    success.onCommandDone(0);
    expect(success.onSuccessElapsed()).toBe("idle");

    const running = new StatusTracker();
    running.onInput("\r");
    expect(running.onSuccessElapsed()).toBe("in-progress");
  });

  it("onFatal goes error", () => {
    expect(new StatusTracker().onFatal()).toBe("error");
  });
});

describe("worstStatus", () => {
  it("picks error > warning > in-progress > success > idle", () => {
    expect(worstStatus([])).toBe("idle");
    expect(worstStatus(["idle", "success"])).toBe("success");
    expect(worstStatus(["success", "in-progress"])).toBe("in-progress");
    expect(worstStatus(["in-progress", "warning", "success"])).toBe("warning");
    expect(worstStatus(["warning", "error", "idle"])).toBe("error");
  });
});
