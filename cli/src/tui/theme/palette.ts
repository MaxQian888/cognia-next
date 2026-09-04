/**
 * Semantic colour tokens for the TUI — the single source every component reads
 * instead of hardcoding ANSI names. A theme is a {@link ThemePalette}; built-in
 * themes (and the Claude Code / Codex reuse path) all produce one of these.
 *
 * Design mirrors Claude Code's token model: a small set of {@link BaseColors}
 * roles (accent / secondary / info / success / warning / danger / muted) drives
 * every concrete element token via {@link expandPalette}, so a theme only has to
 * declare ~8 colours. Individual tokens can still be overridden (this is how a
 * custom Claude `overrides` map is layered on top of its base).
 *
 * Colour values are whatever Ink's `<Text color>` accepts: an ANSI name
 * (`"cyan"`), a hex string (`"#7aa2f7"`), or `rgb(r,g,b)`. Ink routes through
 * chalk, which down-samples truecolour to the terminal's capability, so the
 * Claude hex themes render everywhere.
 */

/** The ~8 role colours a theme declares; every element token derives from these. */
export interface BaseColors {
  /** Primary brand / active accent — borders, headings, selection. Classic: cyan. */
  accent: string
  /** Secondary accent — reasoning, MCP tools, h3. Classic: magenta. */
  secondary: string
  /** Informational — links, directories, h2. Classic: blue. */
  info: string
  /** Success / positive. Classic: green. */
  success: string
  /** Warning / intermediate. Classic: yellow. */
  warning: string
  /** Error / negative. Classic: red. */
  danger: string
  /** Muted / dimmed / neutral secondary text + subtle borders. Classic: gray. */
  muted: string
  /** Default body foreground. Omit ⇒ the terminal's own default (classic). */
  text?: string
}

/** The full set of element tokens components consume. */
export interface ThemePalette extends Required<Omit<BaseColors, "text">> {
  /** Default body foreground, or undefined for the terminal default. */
  text?: string
  // structure
  border: string
  borderSubtle: string
  borderWarning: string
  // markdown headings
  heading1: string
  heading2: string
  heading3: string
  // markdown inline
  link: string
  inlineCode: string
  /** Subtle background behind inline `code` spans. Optional: themes built as a
   * raw literal (not via {@link expandPalette}) may omit it ⇒ no background. */
  inlineCodeBg?: string
  blockquote: string
  // chat
  userPrompt: string
  thinking: string
  // diff
  diffAdded: string
  diffRemoved: string
  // external tools
  toolMcp: string
  toolPlugin: string
  // tool/turn status
  statusRunning: string
  statusDone: string
  statusError: string
  // permission risk
  riskLow: string
  riskMedium: string
  riskHigh: string
  // mascot moods
  mascotIdle: string
  mascotThinking: string
  mascotWorking: string
  mascotStopping: string
  // selection highlight
  selected: string
  /** The composer's own block caret, drawn where the terminal cursor is hidden. */
  caret: string
  // fenced code-block syntax highlighting (mapped to a cli-highlight theme).
  codeKeyword: string
  codeString: string
  codeNumber: string
  codeComment: string
  codeFunction: string
  codeBuiltin: string
  /** Display name of the reused code-block theme (e.g. a Codex theme), for the
   * picker / status. Undefined ⇒ the theme's own derived code colours. */
  codeHighlight?: string
}

/**
 * Expand the ~8 base roles into the full element-token palette, then layer any
 * explicit per-token `overrides` on top. Pure — never mutates `base`.
 */
export function expandPalette(base: BaseColors, overrides?: Partial<ThemePalette>): ThemePalette {
  const { accent, secondary, info, success, warning, danger, muted, text } = base
  const derived: ThemePalette = {
    accent,
    secondary,
    info,
    success,
    warning,
    danger,
    muted,
    ...(text !== undefined ? { text } : {}),
    // structure
    border: accent,
    borderSubtle: muted,
    borderWarning: warning,
    // headings
    heading1: accent,
    heading2: info,
    heading3: secondary,
    // markdown inline. `inlineCode` is a distinct foreground (no background) for
    // a clean, natural look — a full-cell bg block reads heavy and inconsistent
    // across terminals. A theme can still opt into a subtle bg via an override.
    link: info,
    inlineCode: warning,
    blockquote: muted,
    // chat
    userPrompt: success,
    thinking: secondary,
    // diff
    diffAdded: success,
    diffRemoved: danger,
    // tools
    toolMcp: secondary,
    toolPlugin: info,
    // status
    statusRunning: warning,
    statusDone: success,
    statusError: danger,
    // risk
    riskLow: success,
    riskMedium: warning,
    riskHigh: danger,
    // mascot
    mascotIdle: muted,
    mascotThinking: secondary,
    mascotWorking: warning,
    mascotStopping: danger,
    // selection
    selected: accent,
    caret: accent,
    // code-block syntax tokens
    codeKeyword: secondary,
    codeString: success,
    codeNumber: warning,
    codeComment: muted,
    codeFunction: info,
    codeBuiltin: accent,
  }
  return overrides ? { ...derived, ...overrides } : derived
}
