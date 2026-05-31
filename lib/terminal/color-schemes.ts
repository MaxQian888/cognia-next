/**
 * Terminal color schemes — full ANSI 16-color palettes selectable from
 * settings (`settings.terminal.colorScheme`).
 *
 * `resolveTerminalTheme` is the single source of truth consumed by
 * `components/terminal/terminal-instance.tsx`. The special id `"auto"` (the
 * default) follows the app's light/dark mode with a neutral palette that
 * matches `globals.css`; every named scheme is a fixed, well-known palette
 * (Campbell, Dracula, Solarized, One Half, Tango) regardless of app theme.
 *
 * Palettes are the canonical published values for each scheme so PowerShell /
 * oh-my-posh / `ls --color` render exactly as users expect from other
 * terminals.
 */

/** xterm.js `ITheme` subset we populate. All optional in xterm; we set all. */
export interface TerminalTheme {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightWhite: string
  brightMagenta: string
  brightCyan: string
}

export interface TerminalColorScheme {
  /** Stable id persisted in settings. */
  id: string
  /** Display name — a proper noun, shown verbatim (not i18n-translated). */
  name: string
  /** Whether the scheme reads as a dark or light palette (for grouping/preview). */
  appearance: "dark" | "light"
  theme: TerminalTheme
}

export const AUTO_SCHEME_ID = "auto"

/**
 * Neutral palette used by the `"auto"` scheme. The base tokens follow the
 * app's light/dark `bg-background`; the ANSI palette is Windows Terminal's
 * "Campbell" on dark (the canonical PowerShell scheme) and a readable
 * VS Code light palette on light.
 */
function autoTheme(isDark: boolean): TerminalTheme {
  if (isDark) {
    return {
      background: "#0a0a0a",
      foreground: "#e5e5e5",
      cursor: "#e5e5e5",
      selectionBackground: "#3b82f680",
      black: "#0c0c0c",
      red: "#c50f1f",
      green: "#13a10e",
      yellow: "#c19c00",
      blue: "#0037da",
      magenta: "#881798",
      cyan: "#3a96dd",
      white: "#cccccc",
      brightBlack: "#767676",
      brightRed: "#e74856",
      brightGreen: "#16c60c",
      brightYellow: "#f9f1a5",
      brightBlue: "#3b78ff",
      brightMagenta: "#b4009e",
      brightCyan: "#61d6d6",
      brightWhite: "#f2f2f2",
    }
  }
  return {
    background: "#ffffff",
    foreground: "#171717",
    cursor: "#171717",
    selectionBackground: "#3b82f640",
    black: "#171717",
    red: "#cd3131",
    green: "#107c10",
    yellow: "#795e26",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#767676",
    brightRed: "#cd3131",
    brightGreen: "#14ce14",
    brightYellow: "#b5ba00",
    brightBlue: "#0451a5",
    brightMagenta: "#bc05bc",
    brightCyan: "#0598bc",
    brightWhite: "#a5a5a5",
  }
}

/** Named, fixed schemes (independent of app light/dark mode). */
export const TERMINAL_COLOR_SCHEMES: readonly TerminalColorScheme[] = [
  {
    id: "campbell",
    name: "Campbell",
    appearance: "dark",
    theme: {
      background: "#0c0c0c",
      foreground: "#cccccc",
      cursor: "#cccccc",
      selectionBackground: "#3b82f680",
      black: "#0c0c0c",
      red: "#c50f1f",
      green: "#13a10e",
      yellow: "#c19c00",
      blue: "#0037da",
      magenta: "#881798",
      cyan: "#3a96dd",
      white: "#cccccc",
      brightBlack: "#767676",
      brightRed: "#e74856",
      brightGreen: "#16c60c",
      brightYellow: "#f9f1a5",
      brightBlue: "#3b78ff",
      brightMagenta: "#b4009e",
      brightCyan: "#61d6d6",
      brightWhite: "#f2f2f2",
    },
  },
  {
    id: "one-half-dark",
    name: "One Half Dark",
    appearance: "dark",
    theme: {
      background: "#282c34",
      foreground: "#dcdfe4",
      cursor: "#a3b3cc",
      selectionBackground: "#474e5d",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#dcdfe4",
      brightBlack: "#5a6374",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#dcdfe4",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    appearance: "dark",
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    appearance: "dark",
    theme: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#839496",
      selectionBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "tango-dark",
    name: "Tango Dark",
    appearance: "dark",
    theme: {
      background: "#2e3436",
      foreground: "#d3d7cf",
      cursor: "#d3d7cf",
      selectionBackground: "#555753",
      black: "#2e3436",
      red: "#cc0000",
      green: "#4e9a06",
      yellow: "#c4a000",
      blue: "#3465a4",
      magenta: "#75507b",
      cyan: "#06989a",
      white: "#d3d7cf",
      brightBlack: "#555753",
      brightRed: "#ef2929",
      brightGreen: "#8ae234",
      brightYellow: "#fce94f",
      brightBlue: "#729fcf",
      brightMagenta: "#ad7fa8",
      brightCyan: "#34e2e2",
      brightWhite: "#eeeeec",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    appearance: "light",
    theme: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#657b83",
      selectionBackground: "#eee8d5",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "one-half-light",
    name: "One Half Light",
    appearance: "light",
    theme: {
      background: "#fafafa",
      foreground: "#383a42",
      cursor: "#383a42",
      selectionBackground: "#bfceff",
      black: "#383a42",
      red: "#e45649",
      green: "#50a14f",
      yellow: "#c18401",
      blue: "#0184bc",
      magenta: "#a626a4",
      cyan: "#0997b3",
      white: "#fafafa",
      brightBlack: "#4f525d",
      brightRed: "#e45649",
      brightGreen: "#50a14f",
      brightYellow: "#c18401",
      brightBlue: "#0184bc",
      brightMagenta: "#a626a4",
      brightCyan: "#0997b3",
      brightWhite: "#ffffff",
    },
  },
]

const SCHEME_BY_ID = new Map(TERMINAL_COLOR_SCHEMES.map((s) => [s.id, s]))

/** Look up a named scheme, or `undefined` for `"auto"` / unknown ids. */
export function findColorScheme(id: string | undefined): TerminalColorScheme | undefined {
  if (!id || id === AUTO_SCHEME_ID) return undefined
  return SCHEME_BY_ID.get(id)
}

/**
 * Resolve the xterm theme for a scheme id. `"auto"` / unknown → the neutral
 * app-following palette for the current light/dark mode; a named scheme →
 * its fixed palette (the `isDark` arg is ignored for named schemes).
 */
export function resolveTerminalTheme(schemeId: string | undefined, isDark: boolean): TerminalTheme {
  const scheme = findColorScheme(schemeId)
  return scheme ? scheme.theme : autoTheme(isDark)
}
