/**
 * Renders a transcript cell as a width-dependent, styled {@link TerminalBlock}.
 * This is the renderer the virtualized fullscreen viewport paints, so it must
 * carry the same information (and the same colours) as the Ink `CellView` cards
 * the scrollback layout prints. Both read the shared `format/*` helpers, so the
 * two surfaces cannot drift on what a tool call says.
 */
import { tokenizeCached } from "../markdown/render-cache"
import type { DiffLine, MdLine, MdSpan } from "../markdown/types"
import { formatEditDiff } from "../markdown/diff"
import { resultToText } from "../format/result-render"
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

const HEADING_STYLE: Record<number, TerminalStyle> = { 1: "accent", 2: "warning", 3: "success" }

/** One markdown line as styled spans, without a trailing row break. */
function markdownLineSpans(line: MdLine): TerminalSpan[] {
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
        seg(line.text, "code"),
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
    case "table": {
      const row = (cells: MdSpan[][]) =>
        cells.map((cell) => cell.map((span) => span.text).join("")).join(" │ ")
      const header = row(line.header)
      return [
        seg(header, "accent", { bold: true }),
        BREAK,
        seg("─".repeat(Math.max(3, header.length)), "muted"),
        ...line.rows.flatMap((cells) => [BREAK, seg(row(cells), "plain")]),
      ]
    }
  }
}

/** A whole markdown document as styled spans, one row break between lines. */
function markdownSpans(raw: string): TerminalSpan[] {
  const lines = tokenizeCached(sanitizeTerminalText(raw)).map(markdownLineSpans)
  return lines.flatMap((spans, index) => (index === 0 ? spans : [BREAK, ...spans]))
}

function safeResult(result: unknown): string {
  try {
    return resultToText(result)
  } catch {
    return "[unavailable tool result]"
  }
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
function diffSpans(diff: DiffLine[]): TerminalSpan[] {
  return diff.flatMap((line, index) => {
    const signStyle: TerminalStyle =
      line.kind === "add" ? "success" : line.kind === "del" ? "danger" : "muted"
    const gutter =
      line.kind === "meta"
        ? "    "
        : `${(line.oldNo ?? "").toString().padStart(3)} ${(line.newNo ?? "").toString().padStart(3)} `
    const marker = line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "
    return [
      ...(index === 0 ? [] : [BREAK]),
      seg(RULE, "muted"),
      seg(gutter, signStyle),
      seg(marker, signStyle, { bold: true }),
      seg(line.text, line.kind === "meta" ? "muted" : "code"),
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
function toolSpans(cell: ToolCell, verbose: boolean): TerminalSpan[] {
  const expanded = verbose || !cell.collapsed
  const diff = isDiffTool(cell.toolName) ? formatEditDiff(cell.toolName, cell.input) : []
  const hasUsefulResult = cell.result != null && !isUserCancellationResult(cell)
  // A diff renders collapsed or not, so only a hidden result body makes the card
  // collapsible. Same rule the Ink card applies, so a caret means the same thing
  // in either layout.
  const collapsible = diff.length === 0 && hasUsefulResult
  const out = toolHeaderSpans(cell, expanded, collapsible)
  if (diff.length > 0) {
    out.push(BREAK, ...diffSpans(diff))
    return out
  }
  if (!hasUsefulResult) return out
  if (expanded) {
    out.push(BREAK, seg(ruled(safeResult(cell.result)), "muted"))
    return out
  }
  out.push(...detailSpans(cell))
  return out
}

/** A sub-agent dispatch: the same data as a tool cell, framed as a delegated
 * agent (marker, name, dispatch count, status) the way the Ink card frames it. */
function subagentSpans(cell: ToolCell, verbose: boolean): TerminalSpan[] {
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
    out.push(BREAK, seg(ruled(safeResult(cell.result)), "muted"))
    return out
  }
  out.push(...detailSpans(cell))
  return out
}

function cellSpans(cell: Cell, verbose: boolean): { spans: TerminalSpan[]; target?: string } {
  switch (cell.kind) {
    case "user":
      return { spans: [seg("› ", "accent", { bold: true }), seg(cell.text, "plain")] }
    case "assistant":
      return { spans: markdownSpans(cell.raw) }
    case "thinking":
      return {
        spans:
          verbose || !cell.collapsed
            ? [seg("▾ ∴ thinking", "muted"), BREAK, ...markdownSpans(cell.text)]
            : [seg("▸ ∴ thinking", "muted")],
      }
    case "commentary":
      return {
        spans: [
          seg(`${cell.done ? "◆" : "◇"} commentary`, "accent"),
          BREAK,
          ...markdownSpans(cell.text),
        ],
      }
    case "tool":
      return {
        spans: isSubagentTool(cell.toolName)
          ? subagentSpans(cell, verbose)
          : toolSpans(cell, verbose),
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
          ...markdownSpans(cell.raw).map((span) => ({ ...span, style: "muted" as TerminalStyle })),
        ],
        target: "view:plan",
      }
    }
  }
}

export function cellToTerminalBlock(
  cell: Cell,
  options: { width: number; verbose: boolean }
): TerminalBlock {
  const rendered = cellSpans(cell, options.verbose)
  return buildTerminalBlock({
    id: cell.id,
    spans: [...rendered.spans, BREAK],
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
