/**
 * Pure presentation model for the `/agent-stats` panel — aggregate statistics
 * over other coding agents' conversation histories (Claude Code / Codex /
 * OpenCode), read via the `lib/session-import` adapters.
 *
 * I/O-free: the controller parses the on-disk sessions + derives usage rows,
 * then feeds them here. Reuses the desktop analytics stack verbatim —
 * `aggregateByModel` / `aggregateByDay` for the rollups and `analyzeSession`
 * for the per-conversation drill-down — so the CLI and the app agree.
 */
import type { UIMessage } from "ai"

import type { ImportedConversation } from "@/lib/session-import"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { DailyUsage } from "@/types/system/usage"
import {
  aggregateByDay,
  aggregateByModel,
  effectiveCostUsd,
  type ModelUsageRow,
} from "@/lib/usage/session-analytics"
import { analyzeSession, type SessionReport } from "@/lib/analysis/session-report"
import { formatCost, formatTokens } from "../format/usage"
import { stringWidth, truncateToWidth } from "../markdown/width"

/** One conversation + the usage rows derived from its imported `metadata.usage`. */
export interface ConvWithUsage {
  /** Owning source id: "claude-code" | "codex" | "opencode" | "<plugin>:<id>". */
  source: string
  conv: ImportedConversation
  usageRows: SessionUsageRow[]
}

/** One row in the conversation list. */
export interface ConvStatRow {
  /** Stable imported session id (`import:<source>:<id>`). */
  id: string
  source: string
  title: string
  messageCount: number
  toolCalls: number
  tokens: number
  costUsd: number
  updatedAt: number
}

/** Per-source rollup for the "By source" line. */
export interface SourceStat {
  source: string
  conversations: number
  messages: number
  tokens: number
  costUsd: number
}

/** A single date bucket's conversation count. */
export interface DayCount {
  date: string
  count: number
}

/** A single tool's total call count across all conversations. */
export interface ToolCount {
  name: string
  count: number
}

export interface AgentStatsOverview {
  conversations: number
  messages: number
  toolCalls: number
  tokens: number
  costUsd: number
  /** Earliest conversation start (epoch ms), 0 when empty. */
  firstAt: number
  /** Latest conversation activity (epoch ms), 0 when empty. */
  lastAt: number
  bySource: SourceStat[]
  byModel: ModelUsageRow[]
  tokensPerDay: DailyUsage[]
  convsPerDay: DayCount[]
  topTools: ToolCount[]
  /** Truncation / source-availability disclosures — surfaced, never silent. */
  notes: string[]
}

/** Border, padding and the caret the conversation rows sit inside. */
const CONV_ROW_CHROME = 6

/** Below this the title is a fragment rather than a name, so the row shows the
 * metrics alone rather than two useless characters and an ellipsis. */
const MIN_TITLE_COLUMNS = 8

/**
 * The trailing metrics of one conversation row, as a single measurable string.
 *
 * Rendered as-is by the panel, so the width charged for the suffix and the
 * width it actually paints cannot drift apart.
 */
export function convRowMetrics(row: ConvStatRow): string {
  const parts = [`${row.messageCount} msg`]
  if (row.tokens > 0) parts.push(`${formatTokens(row.tokens)} tok`)
  if (row.costUsd > 0) parts.push(formatCost(row.costUsd))
  return ` \u00b7 ${parts.join(" \u00b7 ")}`
}

/**
 * A conversation title cut to the columns left between the source tag and the
 * metrics, measured in display columns.
 *
 * Conversation titles are the user's own first message, so they are frequently
 * CJK, where a character budget buys twice the columns it thinks it does. The
 * row would then wrap, and a wrapped row costs a second terminal row that
 * `windowList` never counted.
 */
export function convRowTitle(row: ConvStatRow, columns: number): string {
  const title = row.title.replace(/\s+/g, " ").trim()
  if (!title) return ""
  const tag = 3 // the two-letter source tag and its trailing space
  const room = columns - CONV_ROW_CHROME - tag - stringWidth(convRowMetrics(row))
  return room < MIN_TITLE_COLUMNS ? "" : truncateToWidth(title, room)
}

/**
 * Extract the source id from a namespaced session id.
 *
 * Two prefixes, both meaning "another agent paid for this". `import:` is what
 * the one-off importer wrote. `ext:` is what the external usage index writes
 * (ADR-0165), and it must be recognized here or every scanned session rolls
 * up under "unknown" while the app attributes it correctly.
 */
export function sourceOfSessionId(id: string): string {
  const m = /^(?:import|ext):([^:]+)(?::|$)/.exec(id)
  return m && m[1].length > 0 ? m[1] : "unknown"
}

function dayKey(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString().slice(0, 10) : ""
}

interface PartLike {
  type?: unknown
}
interface MsgLike {
  role: string
  parts?: unknown
}

/** Count tool-call parts per tool name across a conversation's assistant turns. */
function toolCountsOf(messages: readonly MsgLike[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.parts)) continue
    for (const p of m.parts as PartLike[]) {
      const type = p && typeof p === "object" ? p.type : undefined
      if (typeof type === "string" && type.startsWith("tool-")) {
        const name = type.slice("tool-".length)
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }
  }
  return counts
}

/** Prompt+completion tokens for a set of usage rows (matches `aggregateByDay`). */
function tokensOf(rows: readonly SessionUsageRow[]): number {
  let n = 0
  for (const r of rows) n += r.inputTokens + r.outputTokens + r.cacheReadTokens
  return n
}

function costOf(rows: readonly SessionUsageRow[]): number {
  let c = 0
  for (const r of rows) c += effectiveCostUsd(r)
  return c
}

/** Build the overview + conversation-row list. Pure; sorts by most-recent. */
export function buildAgentStats(
  items: readonly ConvWithUsage[],
  opts: { notes?: string[] } = {}
): { overview: AgentStatsOverview; rows: ConvStatRow[] } {
  const rows: ConvStatRow[] = []
  const allUsage: SessionUsageRow[] = []
  const bySourceMap = new Map<string, SourceStat>()
  const toolTotals = new Map<string, number>()
  const convDayMap = new Map<string, number>()
  let messages = 0
  let toolCalls = 0
  let firstAt = 0
  let lastAt = 0

  for (const item of items) {
    const { conv, usageRows, source } = item
    const tokens = tokensOf(usageRows)
    const cost = costOf(usageRows)
    const toolCounts = toolCountsOf(conv.messages)
    const convToolCalls = [...toolCounts.values()].reduce((a, b) => a + b, 0)
    const updatedAt = conv.session.updatedAt ?? 0
    const createdAt = conv.session.createdAt ?? updatedAt

    rows.push({
      id: conv.session.id,
      source,
      title: conv.session.title ?? "(untitled)",
      messageCount: conv.messages.length,
      toolCalls: convToolCalls,
      tokens,
      costUsd: cost,
      updatedAt,
    })

    allUsage.push(...usageRows)
    messages += conv.messages.length
    toolCalls += convToolCalls
    firstAt = firstAt === 0 ? createdAt : Math.min(firstAt, createdAt)
    lastAt = Math.max(lastAt, updatedAt)

    const src = bySourceMap.get(source) ?? {
      source,
      conversations: 0,
      messages: 0,
      tokens: 0,
      costUsd: 0,
    }
    src.conversations += 1
    src.messages += conv.messages.length
    src.tokens += tokens
    src.costUsd += cost
    bySourceMap.set(source, src)

    for (const [name, n] of toolCounts) toolTotals.set(name, (toolTotals.get(name) ?? 0) + n)

    const day = dayKey(createdAt)
    if (day) convDayMap.set(day, (convDayMap.get(day) ?? 0) + 1)
  }

  rows.sort((a, b) => b.updatedAt - a.updatedAt)

  const overview: AgentStatsOverview = {
    conversations: items.length,
    messages,
    toolCalls,
    tokens: tokensOf(allUsage),
    costUsd: costOf(allUsage),
    firstAt,
    lastAt,
    bySource: [...bySourceMap.values()].sort((a, b) => b.conversations - a.conversations),
    byModel: aggregateByModel(allUsage),
    tokensPerDay: aggregateByDay(allUsage),
    convsPerDay: [...convDayMap.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    topTools: [...toolTotals.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    notes: opts.notes ?? [],
  }
  return { overview, rows }
}

/** Deep per-conversation health report — delegates to the shared analyzer. */
export function buildConvDetail(item: ConvWithUsage): SessionReport {
  return analyzeSession(
    {
      messages: item.conv.messages as unknown as UIMessage[],
      usageRows: item.usageRows,
      sessionMeta: { title: item.conv.session.title },
    },
    {}
  )
}
