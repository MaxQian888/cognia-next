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
  | "light"
  | "dark"
  | "sepia"
  | "github"
  | "dracula"
  | "nord"
  | "solarized"
  | "monokai"

export const THEMES: Record<ThemeId, ThemeTokens> = {
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
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "sepia", label: "Sepia" },
  { id: "github", label: "GitHub" },
  { id: "dracula", label: "Dracula" },
  { id: "nord", label: "Nord" },
  { id: "solarized", label: "Solarized" },
  { id: "monokai", label: "Monokai" },
]
