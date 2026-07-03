/**
 * Canvas Settings Types — editor configuration & preferences.
 * Ported from D:\Project\Cognia\types\canvas\settings.ts with two
 * cognia-next additions: collaboration.serverUrl and execution.pythonRuntime.
 */

export interface CanvasEditorSettings {
  fontSize: number
  fontFamily: string
  /** Enable programming-font ligatures (Fira Code `=>`, `!==`, …). */
  fontLigatures: boolean
  /** Extra horizontal spacing between characters, in px. */
  letterSpacing: number
  lineHeight: number
  tabSize: number
  insertSpaces: boolean
  wordWrap: boolean
  minimap: boolean
  /** Minimap render scale (1–3); higher = larger minimap glyphs. */
  minimapScale: number
  lineNumbers: "on" | "off" | "relative"
  renderWhitespace: "none" | "boundary" | "selection" | "trailing" | "all"
  /** Highlight the line/gutter the cursor sits on. */
  renderLineHighlight: "none" | "gutter" | "line" | "all"
  scrollBeyondLastLine: boolean
  /** Pin the enclosing scope headers to the top while scrolling. */
  stickyScroll: boolean
  /** Max number of pinned sticky-scroll header lines (1–10). */
  stickyScrollMaxLines: number
  /** Show the code-folding gutter controls. */
  folding: boolean
  showFoldingControls: "always" | "mouseover"
  /** Show ghost-text inline completions from the suggestion provider. */
  inlineSuggest: boolean
  autoClosingBrackets: boolean
  autoClosingQuotes: boolean
  formatOnPaste: boolean
  formatOnType: boolean
  cursorBlinking: "blink" | "smooth" | "phase" | "expand" | "solid"
  cursorStyle: "line" | "block" | "underline"
  /** Animate the caret when it moves between positions. */
  cursorSmoothCaretAnimation: "off" | "explicit" | "on"
  smoothScrolling: boolean
  mouseWheelZoom: boolean
  bracketPairColorization: boolean
  /** Inner padding above the first line / below the last line, in px. */
  padding: {
    top: number
    bottom: number
  }
  guides: {
    indentation: boolean
    bracketPairs: boolean
  }
}

export interface CanvasAISettings {
  autoSuggestions: boolean
  suggestionDelay: number
  maxSuggestions: number
  streamingResponses: boolean
  contextLines: number
  suggestionProvider: "default" | "custom"
  customProviderUrl?: string
  enableInlineCompletion: boolean
  showConfidence: boolean
}

export interface CanvasVersionSettings {
  autoSaveInterval: number
  maxVersions: number
  compressOldVersions: boolean
  keepNamedVersions: boolean
  diffViewMode: "inline" | "side-by-side" | "unified"
  showVersionTimestamps: boolean
}

export interface CanvasCollaborationSettings {
  enabled: boolean
  /**
   * cognia-next addition. WebSocket URL for the CRDT signalling server.
   * Empty string ⇒ never connect; useful while collaboration UI ships
   * disabled by default.
   */
  serverUrl: string
  showCursors: boolean
  showAvatars: boolean
  showSelections: boolean
  cursorSmoothing: boolean
  presenceTimeout: number
  syncInterval: number
}

/**
 * Where to run Python code blocks. cognia-next addition.
 * - "none" — Python execution disabled.
 * - "tauri-sidecar" — invoke `canvas_run_python` via Tauri (desktop only).
 *   Web mode falls back to "none" automatically.
 */
export type CanvasPythonRuntime = "none" | "tauri-sidecar"

export interface CanvasExecutionSettings {
  autoExecute: boolean
  maxExecutionTime: number
  showOutput: boolean
  clearOutputOnRun: boolean
  preserveVariables: boolean
  sandboxMode: "strict" | "permissive"
  /** cognia-next addition. */
  pythonRuntime: CanvasPythonRuntime
}

export interface CanvasAccessibilitySettings {
  screenReaderOptimized: boolean
  highContrast: boolean
  reducedMotion: boolean
  focusIndicator: boolean
  announceErrors: boolean
}

export interface CanvasSettings {
  editor: CanvasEditorSettings
  ai: CanvasAISettings
  version: CanvasVersionSettings
  collaboration: CanvasCollaborationSettings
  execution: CanvasExecutionSettings
  accessibility: CanvasAccessibilitySettings
  keybindings: Record<string, string>
  theme: string
}

export const DEFAULT_CANVAS_SETTINGS: CanvasSettings = {
  editor: {
    fontSize: 14,
    fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
    fontLigatures: true,
    letterSpacing: 0,
    lineHeight: 1.5,
    tabSize: 2,
    insertSpaces: true,
    wordWrap: false,
    minimap: true,
    minimapScale: 1,
    lineNumbers: "on",
    renderWhitespace: "selection",
    renderLineHighlight: "line",
    scrollBeyondLastLine: false,
    stickyScroll: true,
    stickyScrollMaxLines: 5,
    folding: true,
    showFoldingControls: "mouseover",
    inlineSuggest: true,
    autoClosingBrackets: true,
    autoClosingQuotes: true,
    formatOnPaste: false,
    formatOnType: false,
    cursorBlinking: "blink",
    cursorStyle: "line",
    cursorSmoothCaretAnimation: "off",
    smoothScrolling: true,
    mouseWheelZoom: false,
    bracketPairColorization: true,
    padding: {
      top: 8,
      bottom: 8,
    },
    guides: {
      indentation: true,
      bracketPairs: true,
    },
  },
  ai: {
    autoSuggestions: true,
    suggestionDelay: 1000,
    maxSuggestions: 5,
    streamingResponses: true,
    contextLines: 50,
    suggestionProvider: "default",
    enableInlineCompletion: true,
    showConfidence: false,
  },
  version: {
    autoSaveInterval: 30,
    maxVersions: 50,
    compressOldVersions: true,
    keepNamedVersions: true,
    diffViewMode: "inline",
    showVersionTimestamps: true,
  },
  collaboration: {
    enabled: false,
    serverUrl: "",
    showCursors: true,
    showAvatars: true,
    showSelections: true,
    cursorSmoothing: true,
    presenceTimeout: 60000,
    syncInterval: 100,
  },
  execution: {
    autoExecute: false,
    maxExecutionTime: 30000,
    showOutput: true,
    clearOutputOnRun: false,
    preserveVariables: true,
    sandboxMode: "strict",
    pythonRuntime: "none",
  },
  accessibility: {
    screenReaderOptimized: false,
    highContrast: false,
    reducedMotion: false,
    focusIndicator: true,
    announceErrors: true,
  },
  keybindings: {},
  theme: "vs-dark",
}

export function mergeSettings(
  base: CanvasSettings,
  overrides: Partial<CanvasSettings>
): CanvasSettings {
  return {
    editor: { ...base.editor, ...overrides.editor },
    ai: { ...base.ai, ...overrides.ai },
    version: { ...base.version, ...overrides.version },
    collaboration: { ...base.collaboration, ...overrides.collaboration },
    execution: { ...base.execution, ...overrides.execution },
    accessibility: { ...base.accessibility, ...overrides.accessibility },
    keybindings: { ...base.keybindings, ...overrides.keybindings },
    theme: overrides.theme ?? base.theme,
  }
}

export function validateSettings(settings: Partial<CanvasSettings>): string[] {
  const errors: string[] = []

  if (settings.editor) {
    if (
      settings.editor.fontSize !== undefined &&
      (settings.editor.fontSize < 8 || settings.editor.fontSize > 72)
    ) {
      errors.push("Font size must be between 8 and 72")
    }
    if (
      settings.editor.tabSize !== undefined &&
      (settings.editor.tabSize < 1 || settings.editor.tabSize > 8)
    ) {
      errors.push("Tab size must be between 1 and 8")
    }
    if (
      settings.editor.lineHeight !== undefined &&
      (settings.editor.lineHeight < 1 || settings.editor.lineHeight > 3)
    ) {
      errors.push("Line height must be between 1 and 3")
    }
    if (
      settings.editor.letterSpacing !== undefined &&
      (settings.editor.letterSpacing < -3 || settings.editor.letterSpacing > 8)
    ) {
      errors.push("Letter spacing must be between -3 and 8")
    }
    if (
      settings.editor.minimapScale !== undefined &&
      (settings.editor.minimapScale < 1 || settings.editor.minimapScale > 3)
    ) {
      errors.push("Minimap scale must be between 1 and 3")
    }
    if (
      settings.editor.stickyScrollMaxLines !== undefined &&
      (settings.editor.stickyScrollMaxLines < 1 || settings.editor.stickyScrollMaxLines > 10)
    ) {
      errors.push("Sticky scroll max lines must be between 1 and 10")
    }
    if (
      settings.editor.padding !== undefined &&
      (settings.editor.padding.top < 0 ||
        settings.editor.padding.top > 40 ||
        settings.editor.padding.bottom < 0 ||
        settings.editor.padding.bottom > 40)
    ) {
      errors.push("Editor padding must be between 0 and 40")
    }
  }

  if (settings.ai) {
    if (
      settings.ai.suggestionDelay !== undefined &&
      (settings.ai.suggestionDelay < 100 || settings.ai.suggestionDelay > 5000)
    ) {
      errors.push("Suggestion delay must be between 100ms and 5000ms")
    }
    if (
      settings.ai.maxSuggestions !== undefined &&
      (settings.ai.maxSuggestions < 1 || settings.ai.maxSuggestions > 20)
    ) {
      errors.push("Max suggestions must be between 1 and 20")
    }
    if (
      settings.ai.contextLines !== undefined &&
      (settings.ai.contextLines < 1 || settings.ai.contextLines > 200)
    ) {
      errors.push("Context lines must be between 1 and 200")
    }
  }

  if (settings.version) {
    if (
      settings.version.autoSaveInterval !== undefined &&
      (settings.version.autoSaveInterval < 10 || settings.version.autoSaveInterval > 300)
    ) {
      errors.push("Auto-save interval must be between 10 and 300 seconds")
    }
    if (
      settings.version.maxVersions !== undefined &&
      (settings.version.maxVersions < 5 || settings.version.maxVersions > 200)
    ) {
      errors.push("Max versions must be between 5 and 200")
    }
  }

  if (settings.execution) {
    if (
      settings.execution.maxExecutionTime !== undefined &&
      (settings.execution.maxExecutionTime < 1000 || settings.execution.maxExecutionTime > 60000)
    ) {
      errors.push("Max execution time must be between 1000ms and 60000ms")
    }
  }

  return errors
}
