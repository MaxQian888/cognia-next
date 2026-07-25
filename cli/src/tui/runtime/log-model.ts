/**
 * Pure presentation + ingestion model for the unified `/logs` panel. Filtering,
 * merging, severity classification, row formatting, and the composer-injection
 * action sequence all live here (Ink-free, React-free, clock-free) so the whole
 * taxonomy unit-tests without a render.
 *
 * The severity vocabulary is deliberately REUSED from `mcp-log-model.ts` rather
 * than cloned — one palette mapping, one label table, one level cycle across
 * both log panels.
 */
import { collapsePaste, PASTE_CHAR_THRESHOLD } from "@/lib/paste-collapse"

import { formatLogTime, levelLabel } from "./mcp-log-model"
import type { LogChannel, LogEntry, McpLogEntry, McpLogLevel, TuiAction } from "../state/types"

/**
 * Max characters kept per captured line. An ACP agent's JSON-RPC frame arrives
 * from `readline` as ONE line and can be megabytes; clamping at ingest is what
 * stops a single message from evicting the entire ring buffer.
 */
export const LOG_MESSAGE_CLAMP = 2000

/** Max entries produced from one source event (a multi-line spawn error). */
export const LOG_MAX_LINES_PER_EVENT = 50

/** Max rows folded into one composer injection. Uncapped, `^A` over a full
 *  buffer would be ~120 KB of prompt. */
export const MAX_INJECT_ROWS = 200

/** Line count above which an injected block collapses to a paste placeholder. */
export const LOG_PASTE_LINE_THRESHOLD = 4

export type LogLevelFilter = McpLogLevel | "all"
export type LogChannelFilter = LogChannel | "all"

/** Level filter options, in cycle order (`all` first). */
export const LOG_LEVEL_FILTERS: LogLevelFilter[] = ["all", "error", "warn", "info", "debug"]

/** Every channel, in a stable display order (used for the header chips). */
export const LOG_CHANNELS: LogChannel[] = ["mcp", "agent", "sidecar", "system"]

export interface LogFilter {
  query: string
  level: LogLevelFilter
  channel: LogChannelFilter
}

/** Truncate an over-long line, keeping a visible note of how much was dropped. */
export function clampMessage(message: string, max = LOG_MESSAGE_CLAMP): string {
  if (message.length <= max) return message
  return `${message.slice(0, max)} …[+${message.length - max} chars]`
}

/**
 * Split one source event's payload into log lines.
 *
 * STATELESS by design: `node-backend.ts` pipes child stdio through
 * `readline.createInterface(...).on("line")`, so a payload is already exactly
 * one newline-stripped line. The only multi-line producer is the spawn-failure
 * path (`child.once("error")` emits `error.message`). A stateful chunk
 * assembler would therefore buy nothing and would strand a partial line
 * forever whenever an agent goes idle or dies mid-line.
 */
export function toLogLines(data: string, max = LOG_MAX_LINES_PER_EVENT): string[] {
  const lines = data.split(/\r?\n/).filter((l) => l.trim() !== "")
  return lines.length <= max ? lines : lines.slice(0, max)
}

/** Fault markers that promote an agent stderr line from `warn` to `error`. */
const STDERR_FAULT = /\b(error|fatal|panic|exception|traceback|ENOENT|EACCES|EPERM)\b/i

/**
 * Severity for an external-agent stderr line. Most agent stderr is noise
 * (progress bars, deprecation warnings, banners), so the floor is `warn` and
 * only a real fault marker promotes to `error`.
 */
export function classifyAgentStderr(line: string): McpLogLevel {
  return STDERR_FAULT.test(line) ? "error" : "warn"
}

/**
 * Project an already-stamped MCP entry into the unified shape. The id is
 * namespaced so a projected row can never collide with a `state.logs` row key.
 */
export function mcpLogToLogEntry(entry: McpLogEntry): LogEntry {
  const origin = entry.server ?? entry.source
  return {
    id: `mcp:${entry.id}`,
    ts: entry.ts,
    level: entry.level,
    channel: "mcp",
    ...(origin ? { origin } : {}),
    message: entry.message,
  }
}

/**
 * Merge the unified buffer with a read-time projection of the MCP buffer.
 *
 * This is why MCP lines are never stored twice: `state.mcpLogs` stays the sole
 * owner of MCP rows and the `/mcp logs` panel is untouched, while `/logs` sees
 * both streams interleaved. Both inputs are already ascending by `ts` (append
 * order), so this is an O(n+m) two-pointer merge, memoized by the panel and
 * therefore only paid while the panel is actually open.
 */
export function mergeLogSources(logs: LogEntry[], mcpLogs: McpLogEntry[]): LogEntry[] {
  if (mcpLogs.length === 0) return logs
  if (logs.length === 0) return mcpLogs.map(mcpLogToLogEntry)
  const out: LogEntry[] = new Array(logs.length + mcpLogs.length)
  let i = 0
  let j = 0
  let k = 0
  while (i < logs.length && j < mcpLogs.length) {
    // `<=` keeps the unified row first on a tie, which is a stable, arbitrary
    // but deterministic choice.
    out[k++] = logs[i].ts <= mcpLogs[j].ts ? logs[i++] : mcpLogToLogEntry(mcpLogs[j++])
  }
  while (i < logs.length) out[k++] = logs[i++]
  while (j < mcpLogs.length) out[k++] = mcpLogToLogEntry(mcpLogs[j++])
  return out
}

/**
 * Filter by level, channel, and a case-insensitive substring query (matched
 * against the message + origin). Preserves order (oldest→newest).
 *
 * Returns the input array UNCHANGED (same reference) when no filter is active,
 * so the common "just opened the panel" render allocates nothing and downstream
 * memos keep their identity.
 */
export function filterLogs(entries: LogEntry[], filter: LogFilter): LogEntry[] {
  const q = filter.query.trim().toLowerCase()
  if (!q && filter.level === "all" && filter.channel === "all") return entries
  return entries.filter((e) => {
    if (filter.level !== "all" && e.level !== filter.level) return false
    if (filter.channel !== "all" && e.channel !== filter.channel) return false
    if (q && !`${e.message} ${e.origin ?? ""}`.toLowerCase().includes(q)) return false
    return true
  })
}

export interface LogCounts {
  levels: Record<McpLogLevel, number>
  channels: Record<LogChannel, number>
  total: number
}

/**
 * Per-level and per-channel tallies in ONE pass. Deliberately independent of
 * the active filter so the panel can memoize it on `entries` alone — tallying
 * on every keystroke of the query would re-walk the whole buffer for nothing.
 */
export function logCounts(entries: LogEntry[]): LogCounts {
  const levels: Record<McpLogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0 }
  const channels: Record<LogChannel, number> = { mcp: 0, agent: 0, sidecar: 0, system: 0 }
  for (const e of entries) {
    levels[e.level]++
    channels[e.channel]++
  }
  return { levels, channels, total: entries.length }
}

/** Channels actually present in the buffer, in stable display order. */
export function presentChannels(entries: LogEntry[]): LogChannel[] {
  const seen = new Set<LogChannel>()
  for (const e of entries) seen.add(e.channel)
  return LOG_CHANNELS.filter((c) => seen.has(c))
}

/** Advance the level filter to the next value in the cycle. */
export function nextLevelFilter(current: LogLevelFilter): LogLevelFilter {
  const i = LOG_LEVEL_FILTERS.indexOf(current)
  return LOG_LEVEL_FILTERS[(i + 1) % LOG_LEVEL_FILTERS.length]
}

/**
 * Advance the channel filter over `["all", ...presentChannels]`. Falls back to
 * `all` when the current selection has aged out of the buffer.
 */
export function nextChannelFilter(
  current: LogChannelFilter,
  entries: LogEntry[]
): LogChannelFilter {
  const cycle: LogChannelFilter[] = ["all", ...presentChannels(entries)]
  const i = cycle.indexOf(current)
  if (i === -1) return "all"
  return cycle[(i + 1) % cycle.length]
}

/** One-line summary of the active filter, shown in the header. */
export function describeLogFilter(filter: LogFilter, total: number, shown: number): string {
  const bits: string[] = [`${shown}/${total}`]
  if (filter.channel !== "all") bits.push(`channel:${filter.channel}`)
  if (filter.level !== "all") bits.push(`level:${filter.level}`)
  if (filter.query.trim()) bits.push(`“${filter.query.trim()}”`)
  return bits.join(" · ")
}

/** `[mcp/github]` — the channel plus its within-channel origin, when known. */
export function channelLabel(entry: LogEntry): string {
  return entry.origin ? `[${entry.channel}/${entry.origin}]` : `[${entry.channel}]`
}

/** One row's plain-text form (clipboard / injection / non-coloured contexts). */
export function formatLogRowText(entry: LogEntry): string {
  return `${formatLogTime(entry.ts)} ${levelLabel(entry.level).trim()} ${channelLabel(entry)} ${entry.message}`
}

/** Join rows into a copy-to-clipboard blob. */
export function formatLogsForCopy(entries: LogEntry[]): string {
  return entries.map(formatLogRowText).join("\n")
}

export interface LogInjection {
  /** Visible one-line lead-in; empty when the composer already has text. */
  lead: string
  /** The fenced block — becomes the paste body, or the raw insert when small. */
  body: string
  /** Rows actually included, after the cap. */
  count: number
}

/**
 * Build the text injected into the composer.
 *
 * Always fenced, including the single-row case: a raw log line can contain
 * backticks, `#` or `|` and would otherwise be re-read as markdown by the
 * model. When over {@link MAX_INJECT_ROWS} the NEWEST rows are kept and the
 * omission is stated inside the fence, so the model is never silently given a
 * truncated picture.
 */
export function buildLogInjection(
  rows: LogEntry[],
  opts: { lead: boolean; scope: string; max?: number }
): LogInjection {
  const max = opts.max ?? MAX_INJECT_ROWS
  const kept = rows.length > max ? rows.slice(rows.length - max) : rows
  const omitted = rows.length - kept.length
  const inner = [
    ...(omitted > 0 ? [`… ${omitted} earlier line${omitted === 1 ? "" : "s"} omitted`] : []),
    ...kept.map(formatLogRowText),
  ].join("\n")
  return {
    lead: opts.lead ? `Analyse these Cognia CLI logs (${opts.scope}):\n\n` : "",
    body: `\`\`\`text\n${inner}\n\`\`\``,
    count: kept.length,
  }
}

/** Blank-line the block when the caret sits mid-text, so the fence starts clean. */
export function composerInsertText(beforeCaret: string, block: string): string {
  return beforeCaret.trim() === "" ? block : `\n${block}`
}

/**
 * Collapse an injected block into a paste placeholder when it's large.
 *
 * REQUIRED, not an optimisation: the CLI composer renders `buffer.lines.map(...)`
 * with no windowing (`Input.tsx`), so inserting 200 raw lines would render a
 * 200-row composer and destroy the layout. The placeholder id is namespaced
 * (`#log<n>`) because `Input.tsx` keys `INPUT_ADD_PASTE` by the placeholder
 * STRING and runs its own independent `pasteSeq` counter — a bare `#0` would
 * collide with the user's next paste and silently overwrite it.
 */
export function collapseLogBlock(body: string, seq: number) {
  const base = collapsePaste(body, seq, LOG_PASTE_LINE_THRESHOLD, PASTE_CHAR_THRESHOLD)
  if (!base.isLarge) return base
  return { ...base, display: `[Logs · ${base.lineCount} lines #log${seq}]` }
}

/** Next free `#log<n>` id, given the pastes already registered. */
export function nextLogPasteSeq(pastes: Record<string, string>): number {
  let seq = 0
  for (const key of Object.keys(pastes)) {
    const m = /#log(\d+)\]$/.exec(key)
    if (m) seq = Math.max(seq, Number(m[1]) + 1)
  }
  return seq
}

/**
 * The exact action sequence that injects log rows into the composer.
 *
 * ORDER IS LOAD-BEARING. `OVERLAY_CLOSE` restores `input.savedCursor` whenever
 * that snapshot is merely IN RANGE for the current buffer — its comment claims
 * it detects "text wasn't changed", but an in-range check is not equivalent to
 * that. After an insert the old cursor is still in range, so closing AFTER the
 * edit drags the caret to the front of the injected block. Closing FIRST
 * restores the caret and drops the snapshot, and `INPUT_EDIT`'s `insertText`
 * then leaves the caret at the end of what it inserted.
 *
 * Returned as data (rather than dispatched here) so the ordering is provable in
 * a plain unit test against the real reducer.
 */
export function logInjectionActions(args: {
  rows: LogEntry[]
  scope: string
  /** Text on the caret's line, left of the caret. */
  beforeCaret: string
  pasteSeq: number
}): TuiAction[] {
  const injection = buildLogInjection(args.rows, {
    lead: args.beforeCaret.trim() === "",
    scope: args.scope,
  })
  const paste = collapseLogBlock(injection.body, args.pasteSeq)
  const visible = paste.isLarge ? paste.display : injection.body
  const text = `${composerInsertText(args.beforeCaret, injection.lead + visible)}\n`
  return [
    { type: "OVERLAY_CLOSE" },
    ...(paste.isLarge
      ? [{ type: "INPUT_ADD_PASTE" as const, id: paste.display, text: paste.stored }]
      : []),
    { type: "INPUT_EDIT", edit: { op: "insert", text } },
    {
      type: "NOTICE",
      message: `Added ${injection.count} log line${injection.count === 1 ? "" : "s"} to the composer.`,
    },
  ]
}

/**
 * Footer hints — TWO rows, both reserved in the row budget.
 *
 * `OverlayFooter` is a plain `<Text>`, so cramming ten bindings onto one row
 * would let Ink WRAP it, silently stealing an item row and re-creating exactly
 * the clipped-cursor bug the row budget exists to prevent. `enter` is spelled
 * out rather than `⏎` because that glyph is double-width in many terminals,
 * which would break the column arithmetic these lengths are pinned to.
 */
export const LOG_PANEL_FOOTER_KEYS =
  "type filter · ↑↓/PgUp/PgDn scroll · Tab level · ⇧Tab channel · esc close"
export const LOG_PANEL_FOOTER_ACTIONS =
  "enter inject · ^A inject all · ^F follow · ^L clear · ^Y copy"
