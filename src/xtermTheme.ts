import type { Palette } from "stewrd-plugin-api";
import type { ITheme } from "@xterm/xterm";

// Maps the host palette to xterm's theme so the terminal always matches the
// active Stewrd theme. No literal colors - everything is derived from
// `palette`.
export function toXtermTheme(palette: Palette): ITheme {
  return {
    background: palette.background,
    foreground: palette.text,
    cursor: palette.accent,
    cursorAccent: palette.background,
    selectionBackground: palette.surfaceHover,
    black: palette.background,
    brightBlack: palette.textMuted,
    red: palette.status.error,
    brightRed: palette.status.error,
    green: palette.status.success,
    brightGreen: palette.status.success,
    yellow: palette.status.warning,
    brightYellow: palette.status.warning,
    blue: palette.accent,
    brightBlue: palette.accent,
    magenta: palette.accent,
    brightMagenta: palette.accent,
    cyan: palette.accent,
    brightCyan: palette.accent,
    white: palette.text,
    brightWhite: palette.text,
  };
}
