/**
 * Project a chat conversation into a portable A2UI app.
 *
 * Mirrors the export pipeline's part handling (`lib/export/text/rich-markdown`):
 * text/reasoning parts contribute visible text; `tool-*` / `dynamic-tool` parts
 * are counted as tool calls. The generated page shows a header, KPI tiles, a
 * per-turn table, a tool-usage summary, and the final assistant output.
 *
 * Pure + deterministic: no clock/random, ids come from `PageAssembler`.
 */

import { createAppMessages, type GeneratedApp } from "@/lib/a2ui/app-generator"
import type { ChatSession, StoredMessage } from "@/lib/claude/types"
import type { A2UIChartDataPoint, A2UITableColumn } from "@/types/a2ui/schema"

import { PageAssembler } from "./builders"
import type { ConversationPageSource, ExecutionPageLabels } from "./types"

type MessagePart = StoredMessage["parts"][number]

/** Concatenate text + reasoning parts into a single visible string. */
export function extractMessageText(parts: StoredMessage["parts"]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type === "text" || part.type === "reasoning") {
      const text = (part as { text?: string }).text
      if (text) chunks.push(text)
    }
  }
  return chunks.join("\n").trim()
}

/** True when a part represents a tool call. */
function isToolPart(part: MessagePart): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool"
}

/** The tool name from a tool part ("tool-bash" → "bash", dynamic → "tool"). */
export function toolNameOf(part: MessagePart): string {
  if (part.type === "dynamic-tool") return "tool"
  return part.type.slice("tool-".length)
}

/** Collapse whitespace and truncate for table previews. */
export function previewText(text: string, maxChars = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed
}

/**
 * Build a `GeneratedApp` visualizing one conversation. The app id is derived
 * from the session id so the same session always maps to the same surface.
 */
export function buildConversationPage(
  source: ConversationPageSource,
  labels: ExecutionPageLabels
): GeneratedApp {
  const { session, messages } = source
  const title = session.title?.trim() || labels.untitled

  // Aggregate counts + per-turn rows + tool tallies in one pass.
  let userCount = 0
  let assistantCount = 0
  let toolCallCount = 0
  const toolTally = new Map<string, number>()
  let lastAssistantText = ""

  const turnRows = messages.map((m, index) => {
    if (m.role === "user") userCount += 1
    else if (m.role === "assistant") assistantCount += 1

    let turnTools = 0
    for (const part of m.parts) {
      if (isToolPart(part)) {
        turnTools += 1
        toolCallCount += 1
        const name = toolNameOf(part)
        toolTally.set(name, (toolTally.get(name) ?? 0) + 1)
      }
    }
    const text = extractMessageText(m.parts)
    if (m.role === "assistant" && text) lastAssistantText = text

    return {
      index: index + 1,
      role: m.role,
      preview: previewText(text) || (turnTools > 0 ? `(${labels.toolCalls})` : ""),
      tools: turnTools,
    }
  })

  const a = new PageAssembler()
  const sections: string[] = []

  // ── Header ──────────────────────────────────────────────────────────────
  const headerTitle = a.text(title, { variant: "heading2" })
  const metaParts = [`${labels.messages}: ${messages.length}`]
  if (session.model) metaParts.push(`${labels.model}: ${session.model}`)
  const headerMeta = a.text(metaParts.join("  ·  "), { variant: "caption" })
  sections.push(a.card({ childrenIds: [a.column([headerTitle, headerMeta], { gap: 1 })] }))

  // ── KPI row ─────────────────────────────────────────────────────────────
  sections.push(
    a.row(
      [
        a.kpi(labels.messages, String(messages.length)),
        a.kpi(labels.user, String(userCount)),
        a.kpi(labels.assistant, String(assistantCount)),
        a.kpi(labels.toolCalls, String(toolCallCount)),
      ],
      { gap: 2, wrap: true }
    )
  )

  // ── Per-turn table ──────────────────────────────────────────────────────
  if (turnRows.length > 0) {
    const columns: A2UITableColumn[] = [
      { key: "index", header: "#", align: "right", type: "number" },
      { key: "role", header: labels.role },
      { key: "preview", header: labels.preview },
      { key: "tools", header: labels.toolCalls, align: "right", type: "number" },
    ]
    const data = turnRows.map((r) => ({
      index: r.index,
      role: r.role === "user" ? labels.user : labels.assistant,
      preview: r.preview,
      tools: r.tools,
    }))
    sections.push(a.table(columns, data, { title: labels.turns }))
  }

  // ── Tool-usage summary (table + bar chart) ──────────────────────────────
  if (toolTally.size > 0) {
    const entries = [...toolTally.entries()].sort((x, y) => y[1] - x[1])
    const columns: A2UITableColumn[] = [
      { key: "tool", header: labels.toolCalls },
      { key: "count", header: "#", align: "right", type: "number" },
    ]
    sections.push(
      a.table(
        columns,
        entries.map(([tool, count]) => ({ tool, count })),
        { title: labels.toolCalls }
      )
    )
    const chartData: A2UIChartDataPoint[] = entries.map(([name, value]) => ({ name, value }))
    sections.push(
      a.chart("bar", chartData, { title: labels.toolCalls, height: 220, showGrid: true })
    )
  }

  // ── Final assistant output ──────────────────────────────────────────────
  if (lastAssistantText) {
    const heading = a.text(labels.finalOutput, { variant: "heading3" })
    const body = a.text(lastAssistantText, { variant: "body" })
    sections.push(a.column([heading, a.card({ childrenIds: [body] })], { gap: 2 }))
  }

  a.root(sections)

  const id = `convo-page-${session.id}`
  return {
    id,
    name: title,
    description: `${labels.messages}: ${messages.length} · ${labels.toolCalls}: ${toolCallCount}`,
    components: a.components,
    dataModel: {},
    messages: createAppMessages(id, title, a.components, {}),
  }
}

/** Re-export for callers that only need the session type alias. */
export type { ChatSession }
