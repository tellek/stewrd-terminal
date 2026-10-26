// Tauri 2.12 rejects an unknown command with "Command <name> not found".
export function isCommandNotFound(err: unknown, command: string): boolean {
  return new RegExp(`Command ${command} not found`, "i").test(String(err));
}

// `ver` prints e.g. "Microsoft Windows [Version 10.0.26200.1234]".
export function parseWindowsBuild(verOutput: string): number | undefined {
  const m = /\[Version \d+\.\d+\.(\d+)/i.exec(verOutput);
  return m ? Number(m[1]) : undefined;
}
