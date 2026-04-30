/**
 * Canvas Constants - Shared constant values for Canvas components
 */

import type { ArtifactLanguage } from "@/types"
import type { CanvasActionItem, FormatActionMapping } from "@/types/canvas/panel"

/**
 * Language options for document creation and filtering
 */
export const LANGUAGE_OPTIONS: { value: ArtifactLanguage; label: string }[] = [
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "json", label: "JSON" },
  { value: "markdown", label: "Markdown" },
  { value: "jsx", label: "JSX" },
  { value: "tsx", label: "TSX" },
  { value: "sql", label: "SQL" },
  { value: "bash", label: "Bash" },
  { value: "yaml", label: "YAML" },
]

/**
 * Languages available for AI translation actions
 */
export const TRANSLATE_LANGUAGES = [
  { value: "english", label: "English" },
  { value: "chinese", label: "中文 (Chinese)" },
  { value: "japanese", label: "日本語 (Japanese)" },
  { value: "korean", label: "한국어 (Korean)" },
  { value: "spanish", label: "Español (Spanish)" },
  { value: "french", label: "Français (French)" },
  { value: "german", label: "Deutsch (German)" },
  { value: "russian", label: "Русский (Russian)" },
  { value: "portuguese", label: "Português (Portuguese)" },
  { value: "arabic", label: "العربية (Arabic)" },
]

/**
 * Canvas AI action definitions (toolbar items)
 */
export const CANVAS_ACTIONS: CanvasActionItem[] = [
  { type: "review", labelKey: "actionReview", icon: "eye", shortcut: "⌘R" },
  { type: "fix", labelKey: "actionFix", icon: "bug", shortcut: "⌘F" },
  { type: "improve", labelKey: "actionImprove", icon: "sparkles", shortcut: "⌘I" },
  { type: "explain", labelKey: "actionExplain", icon: "help", shortcut: "⌘E" },
  { type: "simplify", labelKey: "actionSimplify", icon: "minimize", shortcut: "⌘S" },
  { type: "expand", labelKey: "actionExpand", icon: "maximize", shortcut: "⌘X" },
  { type: "translate", labelKey: "actionTranslate", icon: "languages" },
  { type: "format", labelKey: "actionFormat", icon: "format" },
]

/**
 * Markdown format action mappings for document editing
 */
export const FORMAT_ACTION_MAP: Record<string, FormatActionMapping> = {
  bold: { prefix: "**", suffix: "**" },
  italic: { prefix: "_", suffix: "_" },
  underline: { prefix: "<u>", suffix: "</u>" },
  strikethrough: { prefix: "~~", suffix: "~~" },
  codeBlock: { prefix: "```\n", suffix: "\n```" },
  quote: { prefix: "> ", suffix: "" },
  heading1: { prefix: "# ", suffix: "" },
  heading2: { prefix: "## ", suffix: "" },
  heading3: { prefix: "### ", suffix: "" },
  bulletList: { prefix: "- ", suffix: "" },
  numberedList: { prefix: "1. ", suffix: "" },
  link: { prefix: "[", suffix: "](url)" },
  horizontalRule: { prefix: "\n---\n", suffix: "" },
}

/**
 * Languages that can be opened in the V0 Designer
 */
export const DESIGNER_SUPPORTED_LANGUAGES = ["jsx", "tsx", "html", "javascript", "typescript"]

/**
 * Default keyboard shortcut key-to-action mapping
 */
export const DEFAULT_KEY_ACTION_MAP: Record<string, string> = {
  r: "review",
  f: "fix",
  i: "improve",
  e: "explain",
  s: "simplify",
  x: "expand",
}

/**
 * Reaction emojis available for comments
 */
export const REACTION_EMOJIS = ["👍", "👎", "❤️", "🎉", "🤔", "👀"]

/**
 * Color mapping for suggestion types
 */
export const SUGGESTION_TYPE_COLORS: Record<string, string> = {
  fix: "text-red-500 bg-red-50 dark:bg-red-950/30",
  improve: "text-blue-500 bg-blue-50 dark:bg-blue-950/30",
  comment: "text-yellow-500 bg-yellow-50 dark:bg-yellow-950/30",
  edit: "text-green-500 bg-green-50 dark:bg-green-950/30",
}

/**
 * Keybinding categories for the settings UI
 */
export const KEYBINDING_CATEGORIES: Record<string, string[]> = {
  canvas: [
    "canvas.save",
    "canvas.saveVersion",
    "canvas.undo",
    "canvas.redo",
    "canvas.find",
    "canvas.replace",
    "canvas.goToLine",
    "canvas.format",
    "canvas.toggleWordWrap",
    "canvas.toggleMinimap",
    "canvas.close",
  ],
  action: [
    "action.review",
    "action.fix",
    "action.improve",
    "action.explain",
    "action.simplify",
    "action.expand",
    "action.translate",
    "action.run",
  ],
  navigation: [
    "navigation.nextSuggestion",
    "navigation.prevSuggestion",
    "navigation.acceptSuggestion",
    "navigation.rejectSuggestion",
    "navigation.nextDocument",
    "navigation.prevDocument",
  ],
  view: [
    "view.toggleHistory",
    "view.toggleSuggestions",
    "view.toggleInlineCommand",
    "view.toggleExecution",
  ],
  edit: ["edit.selectAll", "edit.copy", "edit.cut", "edit.paste", "edit.duplicate", "edit.comment"],
  fold: ["fold.foldAll", "fold.unfoldAll", "fold.foldLevel1", "fold.foldLevel2"],
}
