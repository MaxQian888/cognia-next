/**
 * Theme Registry - Editor theme customization for Canvas
 */

export interface EditorTheme {
  id: string
  name: string
  dark: boolean
  base: "vs" | "vs-dark" | "hc-black" | "hc-light"
  colors: ThemeColors
  tokenColors: TokenColorRule[]
}

export interface ThemeColors {
  background: string
  foreground: string
  cursor: string
  selection: string
  selectionHighlight: string
  lineHighlight: string
  lineNumber: string
  lineNumberActive: string
  gutterBackground: string
  gutterForeground: string
  scrollbarSlider: string
  scrollbarSliderHover: string
  scrollbarSliderActive: string
  editorIndentGuide: string
  editorActiveIndentGuide: string
  matchingBracket: string
  findMatch: string
  findMatchHighlight: string
  minimap: string
  minimapSlider: string
}

export interface TokenColorRule {
  name?: string
  scope: string | string[]
  settings: {
    foreground?: string
    background?: string
    fontStyle?: "italic" | "bold" | "underline" | "bold italic"
  }
}

const DEFAULT_DARK_COLORS: ThemeColors = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#aeafad",
  selection: "#264f78",
  selectionHighlight: "#add6ff26",
  lineHighlight: "#2a2d2e",
  lineNumber: "#858585",
  lineNumberActive: "#c6c6c6",
  gutterBackground: "#1e1e1e",
  gutterForeground: "#858585",
  scrollbarSlider: "#79797966",
  scrollbarSliderHover: "#646464b3",
  scrollbarSliderActive: "#bfbfbf66",
  editorIndentGuide: "#404040",
  editorActiveIndentGuide: "#707070",
  matchingBracket: "#515a6b",
  findMatch: "#515c6a",
  findMatchHighlight: "#ea5c0055",
  minimap: "#79797966",
  minimapSlider: "#64646480",
}

const DEFAULT_LIGHT_COLORS: ThemeColors = {
  background: "#ffffff",
  foreground: "#333333",
  cursor: "#000000",
  selection: "#add6ff",
  selectionHighlight: "#add6ff80",
  lineHighlight: "#f5f5f5",
  lineNumber: "#999999",
  lineNumberActive: "#333333",
  gutterBackground: "#ffffff",
  gutterForeground: "#999999",
  scrollbarSlider: "#64646433",
  scrollbarSliderHover: "#64646480",
  scrollbarSliderActive: "#646464b3",
  editorIndentGuide: "#e0e0e0",
  editorActiveIndentGuide: "#c0c0c0",
  matchingBracket: "#c9c9c9",
  findMatch: "#ffdf5d",
  findMatchHighlight: "#ffdf5d66",
  minimap: "#64646433",
  minimapSlider: "#64646480",
}

export const BUILTIN_THEMES: EditorTheme[] = [
  {
    id: "vs-dark",
    name: "Dark+ (default dark)",
    dark: true,
    base: "vs-dark",
    colors: DEFAULT_DARK_COLORS,
    tokenColors: [
      { scope: "comment", settings: { foreground: "#6a9955", fontStyle: "italic" } },
      { scope: "string", settings: { foreground: "#ce9178" } },
      { scope: "keyword", settings: { foreground: "#569cd6" } },
      { scope: "keyword.control", settings: { foreground: "#c586c0" } },
      { scope: "variable", settings: { foreground: "#9cdcfe" } },
      { scope: "entity.name.function", settings: { foreground: "#dcdcaa" } },
      { scope: "entity.name.type", settings: { foreground: "#4ec9b0" } },
      { scope: "constant.numeric", settings: { foreground: "#b5cea8" } },
      { scope: "constant.language", settings: { foreground: "#569cd6" } },
      { scope: "storage.type", settings: { foreground: "#569cd6" } },
      { scope: "support.function", settings: { foreground: "#dcdcaa" } },
    ],
  },
  {
    id: "vs",
    name: "Light+ (default light)",
    dark: false,
    base: "vs",
    colors: DEFAULT_LIGHT_COLORS,
    tokenColors: [
      { scope: "comment", settings: { foreground: "#008000", fontStyle: "italic" } },
      { scope: "string", settings: { foreground: "#a31515" } },
      { scope: "keyword", settings: { foreground: "#0000ff" } },
      { scope: "keyword.control", settings: { foreground: "#af00db" } },
      { scope: "variable", settings: { foreground: "#001080" } },
      { scope: "entity.name.function", settings: { foreground: "#795e26" } },
      { scope: "entity.name.type", settings: { foreground: "#267f99" } },
      { scope: "constant.numeric", settings: { foreground: "#098658" } },
      { scope: "constant.language", settings: { foreground: "#0000ff" } },
      { scope: "storage.type", settings: { foreground: "#0000ff" } },
      { scope: "support.function", settings: { foreground: "#795e26" } },
    ],
  },
  {
    id: "monokai",
    name: "Monokai",
    dark: true,
    base: "vs-dark",
    colors: {
      ...DEFAULT_DARK_COLORS,
      background: "#272822",
      foreground: "#f8f8f2",
      selection: "#49483e",
      lineHighlight: "#3e3d32",
    },
    tokenColors: [
      { scope: "comment", settings: { foreground: "#88846f", fontStyle: "italic" } },
      { scope: "string", settings: { foreground: "#e6db74" } },
      { scope: "keyword", settings: { foreground: "#f92672" } },
      { scope: "variable", settings: { foreground: "#f8f8f2" } },
      { scope: "entity.name.function", settings: { foreground: "#a6e22e" } },
      { scope: "entity.name.type", settings: { foreground: "#66d9ef" } },
      { scope: "constant.numeric", settings: { foreground: "#ae81ff" } },
      { scope: "support.function", settings: { foreground: "#66d9ef" } },
    ],
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    dark: true,
    base: "vs-dark",
    colors: {
      ...DEFAULT_DARK_COLORS,
      background: "#0d1117",
      foreground: "#c9d1d9",
      selection: "#264f78",
      lineHighlight: "#161b22",
    },
    tokenColors: [
      { scope: "comment", settings: { foreground: "#8b949e", fontStyle: "italic" } },
      { scope: "string", settings: { foreground: "#a5d6ff" } },
      { scope: "keyword", settings: { foreground: "#ff7b72" } },
      { scope: "variable", settings: { foreground: "#ffa657" } },
      { scope: "entity.name.function", settings: { foreground: "#d2a8ff" } },
      { scope: "entity.name.type", settings: { foreground: "#79c0ff" } },
      { scope: "constant.numeric", settings: { foreground: "#79c0ff" } },
    ],
  },
  {
    id: "one-dark-pro",
    name: "One Dark Pro",
    dark: true,
    base: "vs-dark",
    colors: {
      ...DEFAULT_DARK_COLORS,
      background: "#282c34",
      foreground: "#abb2bf",
      selection: "#3e4451",
      lineHighlight: "#2c313c",
    },
    tokenColors: [
      { scope: "comment", settings: { foreground: "#5c6370", fontStyle: "italic" } },
      { scope: "string", settings: { foreground: "#98c379" } },
      { scope: "keyword", settings: { foreground: "#c678dd" } },
      { scope: "variable", settings: { foreground: "#e06c75" } },
      { scope: "entity.name.function", settings: { foreground: "#61afef" } },
      { scope: "entity.name.type", settings: { foreground: "#e5c07b" } },
      { scope: "constant.numeric", settings: { foreground: "#d19a66" } },
    ],
  },
]

export class ThemeRegistry {
  private themes: Map<string, EditorTheme> = new Map()
  private activeThemeId: string = "vs-dark"

  constructor() {
    for (const theme of BUILTIN_THEMES) {
      this.themes.set(theme.id, theme)
    }
  }

  registerTheme(theme: EditorTheme): void {
    this.themes.set(theme.id, theme)
  }

  unregisterTheme(themeId: string): boolean {
    if (BUILTIN_THEMES.some((t) => t.id === themeId)) {
      return false
    }
    return this.themes.delete(themeId)
  }

  getTheme(id: string): EditorTheme | undefined {
    return this.themes.get(id)
  }

  getAllThemes(): EditorTheme[] {
    return Array.from(this.themes.values())
  }

  getDarkThemes(): EditorTheme[] {
    return this.getAllThemes().filter((t) => t.dark)
  }

  getLightThemes(): EditorTheme[] {
    return this.getAllThemes().filter((t) => !t.dark)
  }

  setActiveTheme(themeId: string): boolean {
    if (this.themes.has(themeId)) {
      this.activeThemeId = themeId
      return true
    }
    return false
  }

  getActiveTheme(): EditorTheme | undefined {
    return this.themes.get(this.activeThemeId)
  }

  getActiveThemeId(): string {
    return this.activeThemeId
  }

  toMonacoTheme(theme: EditorTheme): MonacoThemeDefinition {
    const rules: MonacoTokenRule[] = theme.tokenColors.map((tc) => ({
      token: Array.isArray(tc.scope) ? tc.scope[0] : tc.scope,
      foreground: tc.settings.foreground?.replace("#", ""),
      background: tc.settings.background?.replace("#", ""),
      fontStyle: tc.settings.fontStyle,
    }))

    return {
      base: theme.base,
      inherit: true,
      rules,
      colors: {
        "editor.background": theme.colors.background,
        "editor.foreground": theme.colors.foreground,
        "editorCursor.foreground": theme.colors.cursor,
        "editor.selectionBackground": theme.colors.selection,
        "editor.selectionHighlightBackground": theme.colors.selectionHighlight,
        "editor.lineHighlightBackground": theme.colors.lineHighlight,
        "editorLineNumber.foreground": theme.colors.lineNumber,
        "editorLineNumber.activeForeground": theme.colors.lineNumberActive,
        "editorGutter.background": theme.colors.gutterBackground,
        "scrollbarSlider.background": theme.colors.scrollbarSlider,
        "scrollbarSlider.hoverBackground": theme.colors.scrollbarSliderHover,
        "scrollbarSlider.activeBackground": theme.colors.scrollbarSliderActive,
        "editorIndentGuide.background": theme.colors.editorIndentGuide,
        "editorIndentGuide.activeBackground": theme.colors.editorActiveIndentGuide,
        "editorBracketMatch.background": theme.colors.matchingBracket,
        "editor.findMatchBackground": theme.colors.findMatch,
        "editor.findMatchHighlightBackground": theme.colors.findMatchHighlight,
        "minimap.background": theme.colors.minimap,
        "minimapSlider.background": theme.colors.minimapSlider,
      },
    }
  }

  exportTheme(themeId: string): string | null {
    const theme = this.themes.get(themeId)
    if (!theme) return null
    return JSON.stringify(theme, null, 2)
  }

  importTheme(json: string): EditorTheme | null {
    try {
      const theme = JSON.parse(json) as EditorTheme
      if (theme.id && theme.name && theme.colors && theme.tokenColors) {
        this.registerTheme(theme)
        return theme
      }
      return null
    } catch {
      return null
    }
  }
}

export interface MonacoThemeDefinition {
  base: "vs" | "vs-dark" | "hc-black" | "hc-light"
  inherit: boolean
  rules: MonacoTokenRule[]
  colors: Record<string, string>
}

export interface MonacoTokenRule {
  token: string
  foreground?: string
  background?: string
  fontStyle?: string
}

export const themeRegistry = new ThemeRegistry()

export default ThemeRegistry
