import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createQuietTimer } from "./quietTimer";
import { StatusTracker } from "./statusTracker";

describe("createQuietTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once after the last chunk, not before", () => {
    const onQuiet = vi.fn();
    const t = createQuietTimer(700, onQuiet);
    t.touch();
    vi.advanceTimersByTime(500);
    t.touch();
    vi.advanceTimersByTime(500);
    expect(onQuiet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onQuiet).toHaveBeenCalledTimes(1);
  });

  it("does not fire after cancel", () => {
    const onQuiet = vi.fn();
    const t = createQuietTimer(700, onQuiet);
    t.touch();
    t.cancel();
    vi.advanceTimersByTime(2000);
    expect(onQuiet).not.toHaveBeenCalled();
  });

  it("re-arms for a later burst after firing", () => {
    const onQuiet = vi.fn();
    const t = createQuietTimer(700, onQuiet);
    t.touch();
    vi.advanceTimersByTime(700);
    t.touch();
    vi.advanceTimersByTime(700);
    expect(onQuiet).toHaveBeenCalledTimes(2);
  });

  it("output then silence on a question line reaches warning", () => {
    const tracker = new StatusTracker();
    tracker.onInput("\r");
    let state = tracker.getState();
    const t = createQuietTimer(700, () => {
      state = tracker.onQuiet("Continue? (y/n)");
    });
    tracker.onOutput();
    t.touch();
    vi.advanceTimersByTime(700);
    expect(state).toBe("warning");
  });
});
