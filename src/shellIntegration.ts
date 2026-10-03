import type { PluginApi } from "stewrd-plugin-api";

// Shell integration script: wraps the user's `prompt` function to emit
// OSC 133 markers (the same protocol VS Code / iTerm2 / Windows Terminal
// use) so the plugin can tell when a command starts, finishes, and what its
// exit code was - without scraping visible text.
//
// `$c` is captured as the very first statement so it reflects the exit
// status of the user's last command, before any of our own code (which
// would reset `$?`) runs.
function buildScript(): string {
  const ESC = "([char]27)";
  const BEL = "([char]7)";
  return [
    "$global:__stewrdLastHistId = (Get-History -Count 1 | Select-Object -ExpandProperty Id -ErrorAction SilentlyContinue)",
    "if (-not $global:__stewrdLastHistId) { $global:__stewrdLastHistId = 0 }",
    "$global:__stewrdOriginalPrompt = $function:prompt",
    "function prompt {",
    "  $c = [int]!$global:?",
    "  $h = Get-History -Count 1",
    "  $lastId = 0",
    "  if ($h) { $lastId = $h.Id }",
    "  if ($lastId -ne $global:__stewrdLastHistId) {",
    "    $global:__stewrdLastHistId = $lastId",
    `    Write-Host -NoNewline (${ESC} + "]133;D;$c" + ${BEL})`,
    "  } else {",
    `    Write-Host -NoNewline (${ESC} + "]133;D" + ${BEL})`,
    "  }",
    `  Write-Host -NoNewline (${ESC} + "]133;A" + ${BEL})`,
    "  if ($c -eq 1) { Write-Error '' -ErrorAction Ignore }",
    "  & $global:__stewrdOriginalPrompt",
    "}",
  ].join("\r\n");
}

function encodeCommand(script: string): string {
  const utf16le = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i);
    utf16le[i * 2] = code & 0xff;
    utf16le[i * 2 + 1] = (code >> 8) & 0xff;
  }
  let binary = "";
  for (let i = 0; i < utf16le.length; i++) binary += String.fromCharCode(utf16le[i]);
  return btoa(binary);
}

export interface ShellLaunch {
  program: string;
  args: string[];
}

// Cached as a promise so panes opening at the same time share one where.exe.
let shellPromise: Promise<ShellLaunch> | null = null;

export function pickShell(api: PluginApi): Promise<ShellLaunch> {
  shellPromise ??= (async () => {
    let program = "powershell.exe";
    try {
      const result = await api.shell.exec("where.exe", ["pwsh"]);
      if (result.code === 0) program = "pwsh";
    } catch {
      // fall back to powershell.exe
    }
    const encoded = encodeCommand(buildScript());
    return { program, args: ["-NoLogo", "-NoExit", "-EncodedCommand", encoded] };
  })();
  return shellPromise;
}
