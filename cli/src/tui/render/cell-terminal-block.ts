import { tokenizeCached } from "../markdown/render-cache"
import type { MdLine, MdSpan } from "../markdown/types"
import { formatEditDiff } from "../markdown/diff"
import { resultToText } from "../format/result-render"
import { isDiffTool, resultPreview, summarizeToolCall, toolDisplayName } from "../format/tools"
import type { Cell } from "../state/types"
import {
  buildTerminalBlock,
  sanitizeTerminalText,
  type TerminalBlock,
  type TerminalStyle,
} from "./terminal-block"

function spansText(spans: MdSpan[]): string {
  return spans
    .map((span) =>
      span.link && span.link !== span.text ? `${span.text} (${span.link})` : span.text
    )
    .join("")
}

function markdownLineText(line: MdLine): string[] {
  switch (line.kind) {
    case "heading":
      return [`${"#".repeat(line.level)} ${spansText(line.spans)}`]
    case "paragraph":
      return [spansText(line.spans)]
    case "code":
      return [
        ...(line.first ? [`╭─ ${line.lang || "code"}`] : []),
        `│ ${line.text}`,
        ...(line.last ? ["╰─"] : []),
      ]
    case "blockquote":
      return [`${"│ ".repeat(Math.max(1, line.depth ?? 1))}${spansText(line.spans)}`]
    case "listitem": {
      const marker = line.checked === undefined ? line.marker : line.checked ? "☑" : "☐"
      return [`${"  ".repeat(line.depth + 1)}${marker} ${spansText(line.spans)}`]
    }
    case "rule":
      return ["────────────────────────"]
    case "blank":
      return [""]
    case "table": {
      const row = (cells: MdSpan[][]) => cells.map(spansText).join(" │ ")
      const header = row(line.header)
      return [header, "─".repeat(Math.max(3, header.length)), ...line.rows.map(row)]
    }
  }
}

function markdownText(raw: string): string {
  return tokenizeCached(sanitizeTerminalText(raw)).flatMap(markdownLineText).join("\n")
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

function cellText(
  cell: Cell,
  verbose: boolean
): { text: string; style: TerminalStyle; target?: string } {
  switch (cell.kind) {
    case "user":
      return { text: `› ${cell.text}`, style: "accent" }
    case "assistant":
      return { text: markdownText(cell.raw), style: "plain" }
    case "thinking":
      return {
        text:
          verbose || !cell.collapsed ? `▾ ∴ thinking\n${markdownText(cell.text)}` : "▸ ∴ thinking",
        style: "muted",
      }
    case "commentary":
      return {
        text: `${cell.done ? "◆" : "◇"} commentary\n${markdownText(cell.text)}`,
        style: "muted",
      }
    case "tool": {
      const icon =
        cell.status === "done"
          ? "✓"
          : cell.status === "error"
            ? "✗"
            : cell.status === "cancelled"
              ? "■"
              : "⏳"
      const summary = summarizeToolCall(cell.toolName, cell.input)
      const details: string[] = []
      if (isDiffTool(cell.toolName)) {
        details.push(...formatEditDiff(cell.toolName, cell.input).map((line) => line.text))
      } else if ((verbose || !cell.collapsed) && cell.result !== undefined) {
        details.push(safeResult(cell.result))
      } else if (cell.collapsed && cell.result !== undefined) {
        const preview = resultPreview(cell.result)
        if (preview) details.push(`  ↳ ${preview}`)
      }
      return {
        text: [
          `${icon} ${cell.displayTitle ?? toolDisplayName(cell.toolName)}${summary ? ` ${summary}` : ""}`,
          ...details,
        ].join("\n"),
        style: cell.status === "error" ? "danger" : cell.status === "cancelled" ? "muted" : "plain",
      }
    }
    case "todo":
      return {
        text: [
          "Todos",
          ...cell.todos.map(
            (todo) =>
              `${todo.status === "completed" ? "☑" : todo.status === "in_progress" ? "▣" : "☐"} ${todo.content}`
          ),
        ].join("\n"),
        style: "plain",
      }
    case "error":
      return { text: `✗ ${cell.message}${cell.hint ? `\n  ↳ ${cell.hint}` : ""}`, style: "danger" }
    case "notice":
      return { text: `• ${cell.message}`, style: "muted" }
    case "canonical-event":
      return {
        text: `${cell.level === "error" ? "✗" : cell.level === "warning" ? "⚠" : "•"} ${cell.title}: ${cell.summary}`,
        style: cell.level === "error" ? "danger" : cell.level === "warning" ? "warning" : "muted",
      }
    case "content-part": {
      const content = contentPartText(cell)
      return { ...content, style: "accent" }
    }
    case "bash":
      return {
        text: `! ${cell.command}${cell.status === "running" ? " …" : ""}${cell.output ? `\n${cell.output}` : ""}`,
        style: cell.status === "error" ? "danger" : "code",
      }
    case "plan":
      return {
        text: `📋 Proposed plan\n${markdownText(cell.raw)}`,
        style: "accent",
        target: "view:plan",
      }
  }
}

export function cellToTerminalBlock(
  cell: Cell,
  options: { width: number; verbose: boolean }
): TerminalBlock {
  const rendered = cellText(cell, options.verbose)
  return buildTerminalBlock({
    id: cell.id,
    text: `${rendered.text}\n`,
    width: options.width,
    style: rendered.style,
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
