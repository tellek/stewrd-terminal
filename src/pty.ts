import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface PtySpawnOptions {
  id: string;
  program: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

export function ptySpawn(opts: PtySpawnOptions): Promise<string> {
  return invoke("pty_spawn", opts);
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

export function onPtyOutput(id: string, fn: (chunk: string) => void): Promise<UnlistenFn> {
  return listen<string>(`pty-output:${id}`, (event) => fn(event.payload));
}

export function onPtyExit(id: string, fn: (code: number) => void): Promise<UnlistenFn> {
  return listen<{ code: number }>(`pty-exit:${id}`, (event) => fn(event.payload.code));
}
