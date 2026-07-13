// Color tokens used by `beautiful-html.ts` and `animated-html.ts`. Each theme
// is a self-contained palette — no Tailwind, no runtime dependencies, all
// colors inlined into the generated `<style>` block so the file works offline.

export interface ThemeTokens {
  /** Page background. */
  bg: string
  /** Card / message bubble background. */
  surface: string
  /** Primary readable text color. */
  text: string
  /** Secondary muted text. */
  muted: string
  /** Border / hairline. */
  border: string
  /** Accent (links, headings). */
  accent: string
  /** User-message bubble background. */
  userBg: string
  /** Assistant-message bubble background. */
  assistantBg: string
  /** Code block background. */
  codeBg: string
  /** Code text. */
  codeText: string
  /** Tool / detail block background. */
  detailBg: string
}

export type ThemeId =
  | "arknights"
  | "cyberpunk"
  | "terminal"
  | "sakura"
  | "catppuccin-mocha"
  | "aurora"
  | "genshin"
  | "honkai"
  | "light"
  | "dark"
  | "sepia"
  | "github"
  | "dracula"
  | "nord"
  | "solarized"
  | "monokai"

export const THEMES: Record<ThemeId, ThemeTokens> = {
  // Rhodes Island / PRTS-inspired tactical-log palette. Pairs with the
  // "arknights" style preset in `style-presets.ts` for the full look.
  arknights: {
    bg: "#0c0f14",
    surface: "#141a23",
    text: "#d6e2ee",
    muted: "#6b7a8c",
    border: "#26313f",
    accent: "#23d5ff",
    userBg: "#12293b",
    assistantBg: "#10151d",
    codeBg: "#080b10",
    codeText: "#9fdcff",
    detailBg: "#161e29",
  },
  cyberpunk: {
    bg: "#0a0612",
    surface: "#160d24",
    text: "#efe6ff",
    muted: "#8f7bb0",
    border: "#3b2260",
    accent: "#ff2ea6",
    userBg: "#241040",
    assistantBg: "#120a1e",
    codeBg: "#07040d",
    codeText: "#f7e94a",
    detailBg: "#1b1030",
  },
  terminal: {
    bg: "#040804",
    surface: "#0a120a",
    text: "#9dfc9d",
    muted: "#4e7a4e",
    border: "#1d3a1d",
    accent: "#33ff66",
    userBg: "#0e1f0e",
    assistantBg: "#081008",
    codeBg: "#020502",
    codeText: "#baffba",
    detailBg: "#0c180c",
  },
  sakura: {
    bg: "#fdf3f5",
    surface: "#fbe8ec",
    text: "#4a2e38",
    muted: "#a3798a",
    border: "#f2cdd8",
    accent: "#d4477a",
    userBg: "#f9dbe4",
    assistantBg: "#fcedf1",
    codeBg: "#3c2530",
    codeText: "#f7d9e3",
    detailBg: "#f7dee6",
  },
  // Catppuccin Mocha — the community-favourite soft-dark pastel palette.
  "catppuccin-mocha": {
    bg: "#1e1e2e",
    surface: "#313244",
    text: "#cdd6f4",
    muted: "#a6adc8",
    border: "#45475a",
    accent: "#cba6f7",
    userBg: "#45475a",
    assistantBg: "#181825",
    codeBg: "#11111b",
    codeText: "#cdd6f4",
    detailBg: "#313244",
  },
  // Aurora — deep teal night sky with a luminous mint-cyan aurora accent.
  aurora: {
    bg: "#071a1c",
    surface: "#0e2a2d",
    text: "#e6fff7",
    muted: "#6fa89e",
    border: "#17403f",
    accent: "#4fe3c1",
    userBg: "#10383a",
    assistantBg: "#0b2427",
    codeBg: "#041214",
    codeText: "#a7f3d0",
    detailBg: "#103032",
  },
  // Genshin — a Teyvat adventurer's parchment journal, teal-and-gold trim.
  genshin: {
    bg: "#f3ead3",
    surface: "#fbf5e6",
    text: "#4a3f2e",
    muted: "#9c8a68",
    border: "#ddceac",
    accent: "#3d8ca3",
    userBg: "#e6dcc0",
    assistantBg: "#fbf5e6",
    codeBg: "#2e4a52",
    codeText: "#d8ecef",
    detailBg: "#ede0c4",
  },
  // Honkai — Astral Express deep-space navy with a trailblazing gold accent.
  honkai: {
    bg: "#0b0a1a",
    surface: "#16142e",
    text: "#ece9ff",
    muted: "#8781b0",
    border: "#2a2652",
    accent: "#e9b949",
    userBg: "#201b46",
    assistantBg: "#110f26",
    codeBg: "#070613",
    codeText: "#f3d98a",
    detailBg: "#1c1838",
  },
  light: {
    bg: "#ffffff",
    surface: "#f9fafb",
    text: "#1f2937",
    muted: "#6b7280",
    border: "#e5e7eb",
    accent: "#2563eb",
    userBg: "#dbeafe",
    assistantBg: "#f3f4f6",
    codeBg: "#1f2937",
    codeText: "#e5e7eb",
    detailBg: "#fef3c7",
  },
  dark: {
    bg: "#0b0d12",
    surface: "#111827",
    text: "#e5e7eb",
    muted: "#9ca3af",
    border: "#1f2937",
    accent: "#60a5fa",
    userBg: "#1e3a8a",
    assistantBg: "#0f172a",
    codeBg: "#020617",
    codeText: "#e2e8f0",
    detailBg: "#3f2f1a",
  },
  sepia: {
    bg: "#f5e8c7",
    surface: "#f1deb1",
    text: "#3d2c1a",
    muted: "#7c5e3a",
    border: "#d4b993",
    accent: "#7b3f00",
    userBg: "#e7c98b",
    assistantBg: "#f1deb1",
    codeBg: "#3d2c1a",
    codeText: "#f5e8c7",
    detailBg: "#e7c98b",
  },
  github: {
    bg: "#ffffff",
    surface: "#f6f8fa",
    text: "#24292f",
    muted: "#57606a",
    border: "#d0d7de",
    accent: "#0969da",
    userBg: "#ddf4ff",
    assistantBg: "#f6f8fa",
    codeBg: "#0d1117",
    codeText: "#c9d1d9",
    detailBg: "#fff8c5",
  },
  dracula: {
    bg: "#282a36",
    surface: "#44475a",
    text: "#f8f8f2",
    muted: "#6272a4",
    border: "#44475a",
    accent: "#bd93f9",
    userBg: "#3a3d4d",
    assistantBg: "#2d2f3b",
    codeBg: "#21222c",
    codeText: "#f8f8f2",
    detailBg: "#44475a",
  },
  nord: {
    bg: "#2e3440",
    surface: "#3b4252",
    text: "#eceff4",
    muted: "#d8dee9",
    border: "#4c566a",
    accent: "#88c0d0",
    userBg: "#434c5e",
    assistantBg: "#3b4252",
    codeBg: "#2e3440",
    codeText: "#eceff4",
    detailBg: "#4c566a",
  },
  solarized: {
    bg: "#fdf6e3",
    surface: "#eee8d5",
    text: "#586e75",
    muted: "#93a1a1",
    border: "#eee8d5",
    accent: "#268bd2",
    userBg: "#cbd9bf",
    assistantBg: "#eee8d5",
    codeBg: "#002b36",
    codeText: "#93a1a1",
    detailBg: "#fdf6e3",
  },
  monokai: {
    bg: "#272822",
    surface: "#3e3d32",
    text: "#f8f8f2",
    muted: "#a6a6a6",
    border: "#3e3d32",
    accent: "#a6e22e",
    userBg: "#3e3d32",
    assistantBg: "#272822",
    codeBg: "#1e1f1c",
    codeText: "#f8f8f2",
    detailBg: "#3e3d32",
  },
}

export const THEME_LIST: { id: ThemeId; label: string }[] = [
  { id: "arknights", label: "Arknights (PRTS)" },
  { id: "cyberpunk", label: "Cyberpunk" },
  { id: "terminal", label: "Terminal" },
  { id: "sakura", label: "Sakura" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha" },
  { id: "aurora", label: "Aurora" },
  { id: "genshin", label: "Genshin (Teyvat)" },
  { id: "honkai", label: "Honkai: Star Rail" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "sepia", label: "Sepia" },
  { id: "github", label: "GitHub" },
  { id: "dracula", label: "Dracula" },
  { id: "nord", label: "Nord" },
  { id: "solarized", label: "Solarized" },
  { id: "monokai", label: "Monokai" },
]
