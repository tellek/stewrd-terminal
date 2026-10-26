import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isCommandNotFound } from "./hostCompat";

export interface PtySpawnOptions {
  id: string;
  program: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

// Prefers pty_spawn_v2 (binary Channel output + flow control) and falls back to
// pty_spawn + "pty-output:<id>" events on a host that predates it. Returns
// whether flow control is active (the caller must then pty_ack processed bytes).
export async function ptySpawn(opts: PtySpawnOptions, onBytes: (bytes: Uint8Array) => void): Promise<boolean> {
  const channel = new Channel<ArrayBuffer | number[]>();
  channel.onmessage = (payload) => onBytes(payload instanceof ArrayBuffer ? new Uint8Array(payload) : Uint8Array.from(payload));
  try {
    await invoke("pty_spawn_v2", { ...opts, onOutput: channel });
    return true;
  } catch (err) {
    if (!isCommandNotFound(err, "pty_spawn_v2")) throw err;
  }
  await invoke("pty_spawn", { ...opts });
  return false;
}

export function ptyAck(id: string, bytes: number): Promise<void> {
  return invoke("pty_ack", { id, bytes });
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

// Only used on the fallback path of ptySpawn (old host); must be registered
// before spawning.
export function onPtyOutput(id: string, fn: (chunk: string) => void): Promise<UnlistenFn> {
  return listen<string>(`pty-output:${id}`, (event) => fn(event.payload));
}

export function onPtyExit(id: string, fn: (code: number) => void): Promise<UnlistenFn> {
  return listen<{ code: number }>(`pty-exit:${id}`, (event) => fn(event.payload.code));
}
