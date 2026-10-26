import { describe, it, expect, vi } from "vitest";
import { createAckBatcher } from "./ackBatcher";
import { createInputCoalescer } from "./inputCoalescer";
import { isCommandNotFound, parseWindowsBuild } from "./hostCompat";
import { StatusTracker } from "./statusTracker";

describe("createAckBatcher", () => {
  it("acks once the batch threshold is reached", () => {
    const ack = vi.fn();
    const b = createAckBatcher(ack, 100);
    const a = b.track(60);
    const c = b.track(60);
    a();
    expect(ack).not.toHaveBeenCalled();
    c();
    expect(ack).toHaveBeenCalledWith(120);
  });

  it("flushes the remainder when the write queue drains", () => {
    const ack = vi.fn();
    const b = createAckBatcher(ack, 5000);
    b.track(10)();
    expect(ack).toHaveBeenCalledWith(10);
  });

  it("acks every byte it tracked", () => {
    const ack = vi.fn();
    const b = createAckBatcher(ack, 100);
    const done = [30, 80, 5, 400, 1].map((n) => b.track(n));
    done.forEach((d) => d());
    const total = ack.mock.calls.reduce((s, [n]) => s + n, 0);
    expect(total).toBe(516);
  });
});

describe("createInputCoalescer", () => {
  it("sends in order and merges input typed while a write is in flight", async () => {
    const sent: string[] = [];
    const resolvers: (() => void)[] = [];
    const c = createInputCoalescer(
      (d) =>
        new Promise<void>((res) => {
          sent.push(d);
          resolvers.push(res);
        }),
      () => {},
    );
    c.push("a");
    c.push("b");
    c.push("c");
    expect(sent).toEqual(["a"]);
    resolvers[0]();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual(["a", "bc"]);
  });

  it("keeps going after a failed write", async () => {
    const onError = vi.fn();
    const sent: string[] = [];
    const c = createInputCoalescer((d) => {
      sent.push(d);
      return sent.length === 1 ? Promise.reject(new Error("x")) : Promise.resolve();
    }, onError);
    c.push("a");
    c.push("b");
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["a", "b"]);
  });
});

describe("hostCompat", () => {
  it("recognises the exact Tauri unknown-command rejection", () => {
    expect(isCommandNotFound("Command pty_spawn_v2 not found", "pty_spawn_v2")).toBe(true);
    expect(isCommandNotFound(new Error("Command pty_spawn_v2 not found"), "pty_spawn_v2")).toBe(true);
    expect(isCommandNotFound("failed to spawn pwsh", "pty_spawn_v2")).toBe(false);
    expect(isCommandNotFound("Command pty_write not found", "pty_spawn_v2")).toBe(false);
  });

  it("parses the Windows build number from ver output", () => {
    expect(parseWindowsBuild("\r\nMicrosoft Windows [Version 10.0.26200.1234]\r\n")).toBe(26200);
    expect(parseWindowsBuild("garbage")).toBeUndefined();
  });
});

describe("StatusTracker.onOutput", () => {
  it("only changes state from warning, so callers can skip status work otherwise", () => {
    const t = new StatusTracker();
    expect(t.onOutput()).toBe("idle");
    t.onInput("\r");
    expect(t.onOutput()).toBe("in-progress");
    t.onQuiet("Continue? (y/n)");
    expect(t.getState()).toBe("warning");
    expect(t.onOutput()).toBe("in-progress");
  });
});
