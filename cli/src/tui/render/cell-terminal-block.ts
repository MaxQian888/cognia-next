/**
 * Renders a transcript cell as a width-dependent, styled {@link TerminalBlock}.
 * This is the renderer the virtualized fullscreen viewport paints, so it must
 * carry the same information (and the same colours) as the Ink `CellView` cards
 * the scrollback layout prints. Both read the shared `format/*` helpers, so the
 * two surfaces cannot drift on what a tool call says.
 */
import { tokenizeCached } from "../markdown/render-cache"
import {
  cellRefText,
  collectTableFootnotes,
  fitCell,
  TABLE_FRAME,
  TABLE_RULE_BOTTOM,
  TABLE_RULE_MID,
  TABLE_RULE_TOP,
  tableLayout,
  tableRule,
} from "../markdown/table-layout"
import type { DiffLine, MdLine, MdSpan } from "../markdown/types"
import { diffFilePath, formatEditDiff } from "../markdown/diff"
import { highlightLine, langFromPath, paletteCodeTheme } from "../markdown/highlight"
import { renderResultLines, resultToText, toolResultLang } from "../format/result-render"
import {
  isDiffTool,
  resultPreview,
  summarizeToolCall,
  toolGlyph,
  toolHeaderLabel,
  toolKind,
} from "../format/tools"
import {
  describeToolResult,
  formatResultDescriptor,
  isDetailDescriptor,
  type ResultTone,
  type ToolResultDescriptor,
} from "../format/tool-result"
import { isContextTool } from "../format/context-group"
import { ansiToSpans } from "./ansi-spans"
import { RENDER_DEFAULTS, type ResolvedRenderConfig } from "../../config/schema"
import type { ThemePalette } from "../theme/palette"
import {
  isSubagentTool,
  subagentDispatchCount,
  subagentName,
  subagentTask,
} from "../format/subagent"
import { planStats, planTitle } from "../runtime/plan"
import type { Cell, ToolCell } from "../state/types"
import {
  buildTerminalBlock,
  sanitizeTerminalText,
  type TerminalBlock,
  type TerminalSpan,
  type TerminalStyle,
} from "./terminal-block"

/** Build one styled span. Keeps the cell writers below terse and uniform. */
function seg(
  text: string,
  style: TerminalStyle = "plain",
  extra?: Omit<TerminalSpan, "text" | "style">
): TerminalSpan {
  return { text, style, ...extra }
}

/** Row separator between the styled lines of a cell. */
const BREAK: TerminalSpan = { text: "\n", style: "plain" }

/** A result chip's tone mapped onto the block renderer's style vocabulary. */
const TONE_STYLE: Record<ResultTone, TerminalStyle> = {
  neutral: "muted",
  success: "success",
  error: "danger",
}

function spanStyle(span: MdSpan): {
  style: TerminalStyle
  extra: Omit<TerminalSpan, "text" | "style">
} {
  if (span.code) return { style: "code", extra: {} }
  if (span.link) return { style: "accent", extra: { underline: true } }
  return {
    style: "plain",
    extra: {
      ...(span.bold ? { bold: true } : {}),
      ...(span.italic ? { italic: true } : {}),
    },
  }
}

/** Inline spans of a markdown line, styled: links accented, code tinted. */
function inlineSpans(spans: MdSpan[]): TerminalSpan[] {
  return spans.flatMap((span) => {
    const { style, extra } = spanStyle(span)
    const own = seg(span.text, style, extra)
    return span.link && span.link !== span.text ? [own, seg(` (${span.link})`, "muted")] : [own]
  })
}

/**
 * A GFM table as a framed, column-aligned grid.
 *
 * This surface used to join cells with a bare `" │ "` and rule the header with
 * `"─".repeat(header.length)`, so nothing lined up: columns were as wide as
 * whatever happened to be in the first row, and the rule was measured in code
 * units, which is half the drawn width for CJK. It shares its geometry with the
 * Ink renderer now, so both draw the same table.
 *
 * Links are footnoted below the grid rather than expanded inline, because the
 * `(url)` suffix `inlineSpans` appends elsewhere would push a cell past the
 * column it was measured into.
 */
function tableSpans(
  line: Extract<MdLine, { kind: "table" }>,
  maxWidth: number | undefined
): TerminalSpan[] {
  const footnotes = collectTableFootnotes(line, false)
  const { widths, capped } = tableLayout(line, (spans) => cellRefText(spans, footnotes), maxWidth)
  const cols = line.header.length
  const rule = (ends: Parameters<typeof tableRule>[1]) => seg(tableRule(widths, ends), "muted")
  const row = (cells: MdSpan[][], header: boolean): TerminalSpan[] => {
    const out: TerminalSpan[] = [seg(TABLE_FRAME.vertical, "muted")]
    for (let c = 0; c < cols; c++) {
      const spans = cells[c] ?? []
      const fit = fitCell(cellRefText(spans, footnotes), widths[c], line.align[c] ?? null, capped)
      out.push(seg(` ${fit.left}`, "muted"))
      if (fit.truncated) {
        out.push(seg(fit.text, header ? "accent" : "plain", header ? { bold: true } : undefined))
      } else {
        out.push(...tableCellSpans(spans, footnotes, header))
      }
      out.push(seg(`${fit.right} `, "muted"), seg(TABLE_FRAME.vertical, "muted"))
    }
    return out
  }
  return [
    rule(TABLE_RULE_TOP),
    BREAK,
    ...row(line.header, true),
    BREAK,
    rule(TABLE_RULE_MID),
    ...line.rows.flatMap((cells) => [BREAK, ...row(cells, false)]),
    BREAK,
    rule(TABLE_RULE_BOTTOM),
    ...footnotes.flatMap((url, i) => [BREAK, seg(`[${i + 1}] ${url}`, "muted")]),
  ]
}

/** One cell's styled spans, with a footnoted link written as `label[n]` so the
 * printed text is exactly what the column was measured against. */
function tableCellSpans(spans: MdSpan[], footnotes: string[], header: boolean): TerminalSpan[] {
  return spans.flatMap((span) => {
    const ref = span.link ? footnotes.indexOf(span.link) : -1
    const { style, extra } = spanStyle(span)
    const own = seg(span.text, header ? "accent" : style, header ? { ...extra, bold: true } : extra)
    return ref >= 0 ? [own, seg(`[${ref + 1}]`, "muted")] : [own]
  })
}

const HEADING_STYLE: Record<number, TerminalStyle> = { 1: "accent", 2: "warning", 3: "success" }

/** One markdown line as styled spans, without a trailing row break. */
function markdownLineSpans(
  line: MdLine,
  highlight: boolean,
  palette: ThemePalette | undefined,
  maxWidth: number | undefined
): TerminalSpan[] {
  switch (line.kind) {
    case "heading": {
      const style = HEADING_STYLE[line.level] ?? "muted"
      return [
        seg(`${"#".repeat(line.level)} `, style),
        ...inlineSpans(line.spans).map((span) =>
          span.style === "plain" ? { ...span, style, bold: true } : span
        ),
      ]
    }
    case "paragraph":
      return inlineSpans(line.spans)
    case "code":
      return [
        ...(line.first ? [seg(`╭─ ${line.lang || "code"}`, "muted"), BREAK] : []),
        seg("│ ", "muted"),
        ...(highlight && line.lang
          ? ansiToSpans(
              highlightLine(line.text, line.lang, palette ? paletteCodeTheme(palette) : undefined),
              "code"
            )
          : [seg(line.text, "code")]),
        ...(line.last ? [BREAK, seg("╰─", "muted")] : []),
      ]
    case "blockquote":
      return [
        seg("│ ".repeat(Math.max(1, line.depth ?? 1)), "muted"),
        ...inlineSpans(line.spans).map((span) =>
          span.style === "plain" ? { ...span, style: "muted" as TerminalStyle } : span
        ),
      ]
    case "listitem": {
      const marker = line.checked === undefined ? line.marker : line.checked ? "☑" : "☐"
      return [seg(`${"  ".repeat(line.depth + 1)}${marker} `, "accent"), ...inlineSpans(line.spans)]
    }
    case "rule":
      return [seg("────────────────────────", "muted")]
    case "blank":
      return []
    case "table":
      return tableSpans(line, maxWidth)
  }
}

/** A whole markdown document as styled spans, one row break between lines. */
function markdownSpans(
  raw: string,
  highlight = false,
  palette: ThemePalette | undefined = undefined,
  maxWidth: number | undefined = undefined
): TerminalSpan[] {
  const lines = tokenizeCached(sanitizeTerminalText(raw)).map((line) =>
    markdownLineSpans(line, highlight, palette, maxWidth)
  )
  return lines.flatMap((spans, index) => (index === 0 ? spans : [BREAK, ...spans]))
}

function safeResult(result: unknown): string {
  try {
    return resultToText(result)
  } catch {
    return "[unavailable tool result]"
  }
}

/** How a cell is rendered: the terminal width, the global expand-all toggle, and
 * the user's transcript render preferences. The preferences used to stop at the
 * Ink card path, so `toolResultMaxLines`, `pagerThresholdLines`, `fileLineNumbers`
 * and `syntaxHighlightInline` did nothing in the fullscreen layout that this
 * renderer paints, which is the default one. */
/**
 * Preferences for a surface that must show the transcript VERBATIM: the
 * `/transcript` pager and every export. No cap, no pager fallback, no line
 * numbers or colour, because the output is read (and copied) as source rather
 * than skimmed in a viewport.
 */
export const VERBATIM_RENDER_PREFS: ResolvedRenderConfig = {
  ...RENDER_DEFAULTS,
  toolResultMaxLines: Number.MAX_SAFE_INTEGER,
  pagerThresholdLines: Number.MAX_SAFE_INTEGER,
  syntaxHighlightInline: false,
  fileLineNumbers: false,
}

export interface CellRenderOptions {
  width: number
  verbose: boolean
  prefs?: ResolvedRenderConfig
  /** Palette for theme-aware syntax colours, matching the Ink card path. */
  palette?: ThemePalette
  /**
   * Whether this block ends with a blank row.
   *
   * Defaults to `true`, which is what every cell used to do unconditionally.
   * The composer of a transcript knows what follows this cell and can pack two
   * one-line rows together instead (see `render/transcript-spacing`), which is
   * most of the difference between a screen that holds two exchanges and one
   * that holds four.
   */
  trailingBlank?: boolean
}

/**
 * An expanded tool result as styled rows: syntax-highlighted per the render
 * preferences, optionally line-numbered, capped, each row under the body rule.
 * A result past `pagerThresholdLines` collapses to a short preview plus the
 * "/expand" hint instead of flooding the transcript, exactly as the card does.
 */
function resultBodySpans(
  cell: ToolCell,
  prefs: ResolvedRenderConfig,
  palette: ThemePalette | undefined
): TerminalSpan[] {
  const text = safeResult(cell.result)
  if (!text) return []
  const totalLines = text.split("\n").length
  const tooBig = totalLines > prefs.pagerThresholdLines
  const maxLines = tooBig ? Math.min(prefs.toolResultMaxLines, 20) : prefs.toolResultMaxLines
  const rendered = renderResultLines(text, {
    ...(toolResultLang(cell.toolName, cell.input)
      ? { lang: toolResultLang(cell.toolName, cell.input) }
      : {}),
    highlight: prefs.syntaxHighlightInline,
    lineNumbers: prefs.fileLineNumbers,
    ...(palette ? { palette } : {}),
    maxLines,
  })
  const out: TerminalSpan[] = []
  rendered.lines.forEach((line, index) => {
    if (index > 0) out.push(BREAK)
    out.push(seg(RULE, "muted"), ...ansiToSpans(line, "muted"))
  })
  const note = tooBig
    ? `${totalLines} lines total, open the full output with /expand`
    : rendered.hiddenLines > 0
      ? `+${rendered.hiddenLines} more line${rendered.hiddenLines === 1 ? "" : "s"} hidden, /expand`
      : ""
  if (note) out.push(BREAK, seg(`${RULE}\u2026 ${note}`, "warning"))
  return out
}

function contentPartText(cell: Extract<Cell, { kind: "content-part" }>): {
  text: string
  target?: string
} {
  const part = cell.part
  switch (part.type) {
    case "sources":
      return {
        text: [
          `Sources (${part.sources.length})`,
          ...part.sources.map(
            (source, index) =>
              `[${index + 1}] ${source.title ?? source.origin ?? source.url ?? source.id}${
                typeof source.score === "number" ? ` · ${Math.round(source.score * 100)}%` : ""
              }${source.snippet ? ` — ${source.snippet}` : ""}`
          ),
        ].join("\n"),
        target: `view:${cell.partId}`,
      }
    case "file":
      return {
        text: [
          `File · ${part.name}${part.mediaType ? ` · ${part.mediaType}` : ""}${
            typeof part.size === "number" ? ` · ${part.size} bytes` : ""
          }`,
          part.uri,
          ...(part.preview ? [part.preview] : []),
          `/open ${cell.partId} · /view ${cell.partId}`,
        ].join("\n"),
        target: `open:${cell.partId}`,
      }
    case "a2ui":
      return {
        text: `A2UI surface · ${part.surfaceId}\nSource: ${part.source}\n/view ${cell.partId}`,
        target: `view:${cell.partId}`,
      }
    case "artifact-ref":
      return {
        text: `Artifact · ${part.title ?? part.artifactId}\n/view ${cell.partId}`,
        target: `view:${cell.partId}`,
      }
    case "canvas-ref":
      return {
        text: `Canvas · ${part.title ?? part.canvasId}\n/open ${cell.partId}`,
        target: `open:${cell.partId}`,
      }
    case "custom":
      return {
        text: `${part.customType}\n${part.summary}\nStructured fallback · /view ${cell.partId}`,
        target: `view:${cell.partId}`,
      }
  }
}

/** Static status glyph per tool state. The Ink card animates a spinner while a
 * call runs, which a written block cannot do, so a running call gets the same
 * ellipsis the composer uses. */
const TOOL_GLYPH: Record<ToolCell["status"], string> = {
  running: "⋯",
  done: "✓",
  error: "✗",
  cancelled: "○",
}

const TOOL_STYLE: Record<ToolCell["status"], TerminalStyle> = {
  running: "warning",
  done: "success",
  error: "danger",
  cancelled: "muted",
}

const SUBAGENT_STATUS_LABEL: Record<ToolCell["status"], string> = {
  running: "running",
  done: "done",
  error: "failed",
  cancelled: "stopped",
}

/** Generic cancellation text is lifecycle metadata, not useful tool output. */
function isUserCancellationResult(cell: ToolCell): boolean {
  if (cell.status !== "cancelled" || typeof cell.result !== "string") return false
  return /^cancell?ed by user\.?$/i.test(cell.result.trim())
}

/** The left rule that ties an expanded body to its header row, mirroring the
 * bordered box the Ink card draws. */
const RULE = "  │ "

/** Prefix every physical line of `text` with the body rule. */
function ruled(text: string): string {
  return text
    .split("\n")
    .map((line) => `${RULE}${line}`)
    .join("\n")
}

/** A parsed diff as styled rows: the sign column carries the add/remove colour,
 * the body stays neutral so it reads as code. Same gutter the Ink `DiffView`
 * draws, so a diff occupies the same rows in both renderers. */
function diffSpans(
  diff: DiffLine[],
  lang: string | undefined,
  palette: ThemePalette | undefined
): TerminalSpan[] {
  return diff.flatMap((line, index) => {
    const signStyle: TerminalStyle =
      line.kind === "add" ? "success" : line.kind === "del" ? "danger" : "muted"
    const gutter =
      line.kind === "meta"
        ? "    "
        : `${(line.oldNo ?? "").toString().padStart(3)} ${(line.newNo ?? "").toString().padStart(3)} `
    const marker = line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "
    // The sign column carries the add/remove colour so the body can keep its own
    // syntax highlight, exactly the split the Ink `DiffView` draws.
    const body: TerminalSpan[] =
      line.kind === "meta"
        ? [seg(line.text, "muted")]
        : lang
          ? ansiToSpans(
              highlightLine(line.text, lang, palette ? paletteCodeTheme(palette) : undefined),
              "code"
            )
          : [seg(line.text, "code")]
    return [
      ...(index === 0 ? [] : [BREAK]),
      seg(RULE, "muted"),
      seg(gutter, signStyle),
      seg(marker, signStyle, { bold: true }),
      ...body,
    ]
  })
}

/** The shared header row of a tool card: status, disclosure, namespace badge,
 * bucket glyph, label, input summary and the result chip. */
function toolHeaderSpans(cell: ToolCell, expanded: boolean, hasBody: boolean): TerminalSpan[] {
  const out: TerminalSpan[] = [seg(`${TOOL_GLYPH[cell.status]} `, TOOL_STYLE[cell.status])]
  if (hasBody) out.push(seg(expanded ? "▾ " : "▸ ", "muted"))
  const kind = toolKind(cell.toolName)
  if (kind !== "builtin") out.push(seg(`[${kind}] `, "accent"))
  out.push(seg(`${toolGlyph(cell.toolName)} `, "muted"))
  out.push(seg(cell.displayTitle ?? toolHeaderLabel(cell.toolName), "plain", { bold: true }))
  const summary = summarizeToolCall(cell.toolName, cell.input)
  if (summary) out.push(seg(` ${summary}`, "muted"))
  if (cell.status === "cancelled") out.push(seg(" · stopped", "muted"))
  pushChip(out, describeToolResult(cell))
  return out
}

/** Append the header's result chip. A failure is excluded by
 * {@link isDetailDescriptor} and goes on the detail row instead, the same split
 * the Ink card makes, so one call reads the same in either layout. */
function pushChip(out: TerminalSpan[], descriptor: ToolResultDescriptor | null): void {
  if (!descriptor || isDetailDescriptor(descriptor)) return
  out.push(seg(" · ", "muted"))
  out.push(seg(formatResultDescriptor(descriptor), TONE_STYLE[descriptor.tone]))
}

/** The detail row under a header: a failure's first line, or the first line of
 * a settled result whose chip only carries a size. */
function detailSpans(cell: ToolCell): TerminalSpan[] {
  const descriptor = describeToolResult(cell)
  if (descriptor && isDetailDescriptor(descriptor)) {
    return [BREAK, seg(`  ↳ ${formatResultDescriptor(descriptor)}`, "danger")]
  }
  if (cell.status !== "done") return []
  // A context tool's chip already says how much came back, and the first line of
  // a file or a match list adds nothing. Preview the tools whose output IS the
  // answer (a shell command, an MCP call) instead.
  if (isContextTool(cell.toolName)) return []
  const preview = resultPreview(cell.result)
  return preview ? [BREAK, seg(`  ↳ ${preview}`, "muted")] : []
}

/** A tool cell: header row, then the diff or the result body when expanded, or
 * a single previewed line when it is not. */
function toolSpans(
  cell: ToolCell,
  verbose: boolean,
  prefs: ResolvedRenderConfig,
  palette: ThemePalette | undefined
): TerminalSpan[] {
  const expanded = verbose || !cell.collapsed
  const diff = isDiffTool(cell.toolName) ? formatEditDiff(cell.toolName, cell.input) : []
  const hasUsefulResult = cell.result != null && !isUserCancellationResult(cell)
  // A diff renders collapsed or not, so only a hidden result body makes the card
  // collapsible. Same rule the Ink card applies, so a caret means the same thing
  // in either layout.
  const collapsible = diff.length === 0 && hasUsefulResult
  const out = toolHeaderSpans(cell, expanded, collapsible)
  if (diff.length > 0) {
    const lang = prefs.syntaxHighlightInline
      ? langFromPath(diffFilePath(cell.input) ?? "")
      : undefined
    out.push(BREAK, ...diffSpans(diff, lang, palette))
    return out
  }
  if (!hasUsefulResult) return out
  if (expanded) {
    out.push(BREAK, ...resultBodySpans(cell, prefs, palette))
    return out
  }
  out.push(...detailSpans(cell))
  return out
}

/** A sub-agent dispatch: the same data as a tool cell, framed as a delegated
 * agent (marker, name, dispatch count, status) the way the Ink card frames it. */
function subagentSpans(
  cell: ToolCell,
  verbose: boolean,
  prefs: ResolvedRenderConfig,
  palette: ThemePalette | undefined
): TerminalSpan[] {
  const expanded = verbose || !cell.collapsed
  const hasUsefulResult = cell.result != null && !isUserCancellationResult(cell)
  const dispatches = subagentDispatchCount(cell.input)
  const out: TerminalSpan[] = [seg(`${TOOL_GLYPH[cell.status]} `, TOOL_STYLE[cell.status])]
  if (hasUsefulResult) out.push(seg(expanded ? "▾ " : "▸ ", "muted"))
  out.push(seg(`◆ ${subagentName(cell.input)}`, "accent", { bold: true }))
  out.push(
    seg(
      ` ${dispatches > 1 ? `parallel batch · ${dispatches} agents` : "subagent"} · ${SUBAGENT_STATUS_LABEL[cell.status]}`,
      "muted"
    )
  )
  pushChip(out, describeToolResult(cell))
  const task = subagentTask(cell.input)
  if (task) out.push(BREAK, seg(`  ${task}`, "muted"))
  if (!hasUsefulResult) return out
  if (expanded) {
    out.push(BREAK, ...resultBodySpans(cell, prefs, palette))
    return out
  }
  out.push(...detailSpans(cell))
  return out
}

function cellSpans(
  cell: Cell,
  verbose: boolean,
  prefs: ResolvedRenderConfig,
  palette: ThemePalette | undefined,
  maxWidth: number
): { spans: TerminalSpan[]; target?: string } {
  switch (cell.kind) {
    case "user":
      return { spans: [seg("› ", "accent", { bold: true }), seg(cell.text, "plain")] }
    case "assistant":
      return { spans: markdownSpans(cell.raw, prefs.syntaxHighlightInline, palette, maxWidth) }
    case "thinking":
      return {
        spans:
          verbose || !cell.collapsed
            ? [
                seg("▾ ∴ thinking", "muted"),
                BREAK,
                ...markdownSpans(cell.text, prefs.syntaxHighlightInline, palette, maxWidth),
              ]
            : [seg("▸ ∴ thinking", "muted")],
      }
    case "commentary":
      return {
        spans: [
          seg(`${cell.done ? "◆" : "◇"} commentary`, "accent"),
          BREAK,
          ...markdownSpans(cell.text, prefs.syntaxHighlightInline, palette, maxWidth),
        ],
      }
    case "tool":
      return {
        spans: isSubagentTool(cell.toolName)
          ? subagentSpans(cell, verbose, prefs, palette)
          : toolSpans(cell, verbose, prefs, palette),
      }
    case "todo":
      return {
        spans: [
          seg("Todos", "accent", { bold: true }),
          ...cell.todos.flatMap((todo) => [
            BREAK,
            seg(
              `${todo.status === "completed" ? "☑" : todo.status === "in_progress" ? "▣" : "☐"} `,
              todo.status === "completed"
                ? "success"
                : todo.status === "in_progress"
                  ? "warning"
                  : "muted"
            ),
            seg(todo.content, todo.status === "completed" ? "muted" : "plain"),
          ]),
        ],
      }
    case "error":
      return {
        spans: [
          seg(`✗ ${cell.message}`, "danger"),
          ...(cell.hint ? [BREAK, seg(`  ↳ ${cell.hint}`, "muted")] : []),
        ],
      }
    case "notice":
      return {
        spans:
          cell.tone === "interrupted"
            ? [seg("── ", "muted"), seg("Turn stopped by user", "warning"), seg(" ──", "muted")]
            : [seg(`• ${cell.message}`, "muted")],
      }
    case "canonical-event": {
      const style: TerminalStyle =
        cell.level === "error" ? "danger" : cell.level === "warning" ? "warning" : "muted"
      const glyph = cell.level === "error" ? "✗" : cell.level === "warning" ? "⚠" : "•"
      return {
        spans: [
          seg(`${glyph} `, style),
          seg(cell.title, style, { bold: true }),
          seg(`: ${cell.summary}`, "muted"),
        ],
      }
    }
    case "content-part": {
      const content = contentPartText(cell)
      return {
        spans: [seg(content.text, "accent")],
        ...(content.target ? { target: content.target } : {}),
      }
    }
    case "bash":
      return {
        spans: [
          seg("! ", "accent", { bold: true }),
          seg(cell.command, "plain", { bold: true }),
          ...(cell.status === "running"
            ? [seg(cell.background ? " (background) …" : " …", "warning")]
            : []),
          ...(cell.output
            ? [BREAK, seg(ruled(cell.output), cell.status === "error" ? "danger" : "muted")]
            : []),
        ],
      }
    case "plan": {
      const { steps, lines } = planStats(cell.raw)
      return {
        spans: [
          seg("📋 Plan ready for review", "accent", { bold: true }),
          BREAK,
          seg(
            `${planTitle(cell.raw)} · ${steps > 0 ? `${steps} step${steps === 1 ? "" : "s"}` : `${lines} lines`} · full text via /plan`,
            "muted"
          ),
          BREAK,
          ...markdownSpans(cell.raw, false, undefined, maxWidth).map((span) => ({
            ...span,
            style: "muted" as TerminalStyle,
          })),
        ],
        target: "view:plan",
      }
    }
  }
}

export function cellToTerminalBlock(cell: Cell, options: CellRenderOptions): TerminalBlock {
  const rendered = cellSpans(
    cell,
    options.verbose,
    options.prefs ?? RENDER_DEFAULTS,
    options.palette,
    options.width
  )
  return buildTerminalBlock({
    id: cell.id,
    spans: options.trailingBlank === false ? rendered.spans : [...rendered.spans, BREAK],
    width: options.width,
    ...(rendered.target ? { target: rendered.target } : {}),
  })
}

export interface TerminalBlockCacheKey {
  id: string
  width: number
  theme: string
  preferences: string
  revision: string
}

export class TerminalBlockCache {
  private readonly entries = new Map<string, TerminalBlock>()
  private hits = 0
  private misses = 0

  get(key: TerminalBlockCacheKey, build: () => TerminalBlock): TerminalBlock {
    const serialized = `${key.id}\u0000${key.width}\u0000${key.theme}\u0000${key.preferences}\u0000${key.revision}`
    const cached = this.entries.get(serialized)
    if (cached) {
      this.hits += 1
      return cached
    }
    this.misses += 1
    const block = build()
    this.entries.set(serialized, block)
    return block
  }

  stats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.hits + this.misses
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.entries.size,
      hitRate: total > 0 ? this.hits / total : 0,
    }
  }
}
