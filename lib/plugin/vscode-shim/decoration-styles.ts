/**
 * `window.createTextEditorDecorationType(options)` → CSS classes Monaco
 * decorations can use, as VS Code itself does it.
 *
 * VS Code's `DecorationRenderOptions` describe text styling (colors, border,
 * font, opacity), whole-line styling, `before` / `after` attachments and the
 * overview ruler. Monaco decorations only take class names, so each
 * decoration type (and each distinct per-range `renderOptions`) gets a
 * generated class whose rules go into one `<style>` element. Light/dark
 * variants follow the app's class-based dark mode. Theme colors resolve to
 * the matching `--vscode-*` variable, with a fallback for the common ones.
 *
 * Not drawn: `gutterIconPath` / `contentIconPath` (an image from the
 * extension's files, which the renderer cannot load) and `cursor`. They are
 * dropped and listed by {@link unsupportedDecorationOptions}.
 */

type ThemeColor = { id: string }
type Color = string | ThemeColor

export interface ThemableDecorationAttachment {
  contentText?: string
  border?: string
  borderColor?: Color
  fontStyle?: string
  fontWeight?: string
  textDecoration?: string
  color?: Color
  backgroundColor?: Color
  margin?: string
  width?: string
  height?: string
  contentIconPath?: unknown
}

export interface ThemableDecorationRenderOptions {
  backgroundColor?: Color
  outline?: string
  outlineColor?: Color
  outlineStyle?: string
  outlineWidth?: string
  border?: string
  borderColor?: Color
  borderRadius?: string
  borderSpacing?: string
  borderStyle?: string
  borderWidth?: string
  fontStyle?: string
  fontWeight?: string
  textDecoration?: string
  cursor?: string
  color?: Color
  opacity?: string
  letterSpacing?: string
  gutterIconPath?: unknown
  gutterIconSize?: string
  overviewRulerColor?: Color
  before?: ThemableDecorationAttachment
  after?: ThemableDecorationAttachment
}

export interface DecorationRenderOptions extends ThemableDecorationRenderOptions {
  isWholeLine?: boolean
  /** `DecorationRangeBehavior`: OpenOpen 0, ClosedClosed 1, OpenClosed 2, ClosedOpen 3. */
  rangeBehavior?: number
  /** `OverviewRulerLane`: Left 1, Center 2, Right 4, Full 7. */
  overviewRulerLane?: number
  light?: ThemableDecorationRenderOptions
  dark?: ThemableDecorationRenderOptions
}

/** Fallbacks for theme colors extensions commonly use, when no `--vscode-*` variable is set. */
const THEME_FALLBACKS: Record<string, string> = {
  "editor.findMatchHighlightBackground": "rgba(234, 92, 0, 0.33)",
  "editor.selectionHighlightBackground": "rgba(173, 214, 255, 0.3)",
  "editor.wordHighlightBackground": "rgba(87, 87, 87, 0.25)",
  "editor.rangeHighlightBackground": "rgba(253, 255, 0, 0.2)",
  "editorError.foreground": "#f14c4c",
  "editorWarning.foreground": "#cca700",
  "editorInfo.foreground": "#3794ff",
  "editorCodeLens.foreground": "#999999",
  "editorLineNumber.foreground": "#858585",
  "editorOverviewRuler.errorForeground": "rgba(255, 18, 18, 0.7)",
  "editorOverviewRuler.warningForeground": "#cca700",
  "gitDecoration.addedResourceForeground": "#81b88b",
  "gitDecoration.modifiedResourceForeground": "#e2c08d",
  "gitDecoration.deletedResourceForeground": "#c74e39",
  "editorGutter.addedBackground": "#587c0c",
  "editorGutter.modifiedBackground": "#0c7d9d",
  "editorGutter.deletedBackground": "#94151b",
  descriptionForeground: "#717171",
}

/** A color option as CSS. */
export function cssColor(color: Color | undefined): string | undefined {
  if (color === undefined) return undefined
  if (typeof color === "string") return color
  const variable = `--vscode-${color.id.replace(/\./g, "-")}`
  const fallback = THEME_FALLBACKS[color.id]
  return fallback ? `var(${variable}, ${fallback})` : `var(${variable})`
}

function cssString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}"`
}

/** Declarations for the decorated text itself. */
function textDeclarations(options: ThemableDecorationRenderOptions): string[] {
  const out: string[] = []
  const add = (property: string, value: string | undefined) => {
    if (value !== undefined && value !== "") out.push(`${property}: ${value};`)
  }
  add("background-color", cssColor(options.backgroundColor))
  add("outline", options.outline)
  add("outline-color", cssColor(options.outlineColor))
  add("outline-style", options.outlineStyle)
  add("outline-width", options.outlineWidth)
  add("border", options.border)
  add("border-color", cssColor(options.borderColor))
  add("border-radius", options.borderRadius)
  add("border-spacing", options.borderSpacing)
  add("border-style", options.borderStyle)
  add("border-width", options.borderWidth)
  add("font-style", options.fontStyle)
  add("font-weight", options.fontWeight)
  add("text-decoration", options.textDecoration)
  add("color", cssColor(options.color))
  add("opacity", options.opacity)
  add("letter-spacing", options.letterSpacing)
  return out
}

function attachmentDeclarations(attachment: ThemableDecorationAttachment): string[] {
  const out: string[] = []
  const add = (property: string, value: string | undefined) => {
    if (value !== undefined && value !== "") out.push(`${property}: ${value};`)
  }
  if (attachment.contentText !== undefined) add("content", cssString(attachment.contentText))
  add("border", attachment.border)
  add("border-color", cssColor(attachment.borderColor))
  add("font-style", attachment.fontStyle)
  add("font-weight", attachment.fontWeight)
  add("text-decoration", attachment.textDecoration)
  add("color", cssColor(attachment.color))
  add("background-color", cssColor(attachment.backgroundColor))
  add("margin", attachment.margin)
  add("width", attachment.width)
  add("height", attachment.height)
  if (out.length > 0 && attachment.contentText === undefined) out.unshift('content: "";')
  if (out.length > 0) out.push("display: inline-block;")
  return out
}

export interface DecorationClasses {
  /** For the decorated text (Monaco `inlineClassName`). */
  inlineClassName?: string
  /** For whole lines (Monaco `className` with `isWholeLine`). */
  className?: string
  /** Monaco `before` / `after` injected text classes. */
  beforeContentClassName?: string
  afterContentClassName?: string
  isWholeLine: boolean
  /** Monaco `TrackedRangeStickiness`, which uses VS Code's `DecorationRangeBehavior` numbering. */
  stickiness?: number
  overviewRuler?: { color: string; position: number }
}

/**
 * Build the rules for one set of render options under the class prefix
 * `base`. Returns the classes a Monaco decoration should carry and the CSS
 * that defines them.
 */
export function buildDecorationStyles(
  base: string,
  options: DecorationRenderOptions
): { classes: DecorationClasses; css: string } {
  const rules: string[] = []
  const classes: DecorationClasses = { isWholeLine: options.isWholeLine === true }
  const variants: Array<[string, ThemableDecorationRenderOptions]> = [["", options]]
  if (options.light) variants.push([":root:not(.dark) ", options.light])
  if (options.dark) variants.push([".dark ", options.dark])

  const textClass = `${base}-text`
  const beforeClass = `${base}-before`
  const afterClass = `${base}-after`
  for (const [scope, variant] of variants) {
    const text = textDeclarations(variant)
    if (text.length > 0) {
      rules.push(`${scope}.${textClass} { ${text.join(" ")} }`)
      if (options.isWholeLine) classes.className = textClass
      else classes.inlineClassName = textClass
    }
    const before = variant.before ? attachmentDeclarations(variant.before) : []
    if (before.length > 0) {
      rules.push(`${scope}.${beforeClass}::before { ${before.join(" ")} }`)
      classes.beforeContentClassName = beforeClass
    }
    const after = variant.after ? attachmentDeclarations(variant.after) : []
    if (after.length > 0) {
      rules.push(`${scope}.${afterClass}::after { ${after.join(" ")} }`)
      classes.afterContentClassName = afterClass
    }
  }
  if (options.rangeBehavior !== undefined) classes.stickiness = options.rangeBehavior
  const ruler = cssColor(options.overviewRulerColor)
  if (ruler) classes.overviewRuler = { color: ruler, position: options.overviewRulerLane ?? 7 }
  return { classes, css: rules.join("\n") }
}

/** The options set on a decoration type that are not drawn (see the module comment). */
export function unsupportedDecorationOptions(options: DecorationRenderOptions): string[] {
  const dropped: string[] = []
  for (const variant of [options, options.light, options.dark]) {
    if (!variant) continue
    if (variant.gutterIconPath !== undefined) dropped.push("gutterIconPath")
    if (variant.cursor !== undefined) dropped.push("cursor")
    if (variant.before?.contentIconPath !== undefined) dropped.push("before.contentIconPath")
    if (variant.after?.contentIconPath !== undefined) dropped.push("after.contentIconPath")
  }
  return [...new Set(dropped)]
}

const STYLE_ELEMENT_ID = "cognia-vscode-decorations"
const installed = new Map<string, string>()

function render(): void {
  if (typeof document === "undefined") return
  let element = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null
  if (!element) {
    element = document.createElement("style")
    element.id = STYLE_ELEMENT_ID
    document.head.appendChild(element)
  }
  element.textContent = [...installed.values()].join("\n")
}

/** Add (or replace) the rules owned by `owner`. */
export function installDecorationCss(owner: string, css: string): void {
  if (installed.get(owner) === css) return
  installed.set(owner, css)
  render()
}

export function removeDecorationCss(owner: string): void {
  if (installed.delete(owner)) render()
}

export function __resetDecorationCssForTesting(): void {
  installed.clear()
  render()
}
