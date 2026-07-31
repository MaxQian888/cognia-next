/**
 * Pure presentation model for the `/mcp logs` panel. Filtering, level→palette
 * mapping, filter-cycle transitions, and row formatting live here (Ink-free) so
 * the whole taxonomy unit-tests without a render. The component
 * (`components/McpLogPanel.tsx`) owns only the live view state (query, cursor);
 * everything visible flows from these helpers.
 */
import type { McpLogEntry, McpLogLevel, McpLogSource } from "../state/types"

/** Level filter options, in cycle order (`all` first). */
export const MCP_LOG_LEVEL_FILTERS: Array<McpLogLevel | "all"> = [
  "all",
  "error",
  "warn",
  "info",
  "debug",
]

/** Palette token (see `theme/palette.ts`) for a log level's colour. */
export function levelToken(level: McpLogLevel): "danger" | "warning" | "info" | "muted" {
  switch (level) {
    case "error":
      return "danger"
    case "warn":
      return "warning"
    case "info":
      return "info"
    case "debug":
      return "muted"
  }
}

/** Fixed-width upper-case label for a level column (e.g. `ERR `, `WARN`). */
export function levelLabel(level: McpLogLevel): string {
  const map: Record<McpLogLevel, string> = {
    error: "ERR ",
    warn: "WARN",
    info: "INFO",
    debug: "DBG ",
  }
  return map[level]
}

/** Distinct server names present in the buffer, sorted, for the server filter
 * cycle. Entries without a server contribute nothing (they filter under `all`). */
export function distinctServers(logs: McpLogEntry[]): string[] {
  const seen = new Set<string>()
  for (const l of logs) if (l.server) seen.add(l.server)
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/** Per-level counts across the buffer — feeds the panel header summary. */
export function levelCounts(logs: McpLogEntry[]): Record<McpLogLevel, number> {
  const counts: Record<McpLogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0 }
  for (const l of logs) counts[l.level]++
  return counts
}

export interface McpLogFilter {
  query: string
  level: McpLogLevel | "all"
  server: string | "all"
}

/**
 * Filter the buffer by level, server, and a case-insensitive substring query
 * (matched against the message + server name). Preserves insertion order
 * (oldest→newest).
 */
export function filterMcpLogs(logs: McpLogEntry[], filter: McpLogFilter): McpLogEntry[] {
  const q = filter.query.trim().toLowerCase()
  return logs.filter((l) => {
    if (filter.level !== "all" && l.level !== filter.level) return false
    if (filter.server !== "all" && l.server !== filter.server) return false
    if (q && !`${l.message} ${l.server ?? ""}`.toLowerCase().includes(q)) return false
    return true
  })
}

/** Advance the level filter to the next value in the cycle. */
export function nextLevelFilter(current: McpLogLevel | "all"): McpLogLevel | "all" {
  const i = MCP_LOG_LEVEL_FILTERS.indexOf(current)
  return MCP_LOG_LEVEL_FILTERS[(i + 1) % MCP_LOG_LEVEL_FILTERS.length]
}

/**
 * Advance the server filter to the next value in `["all", ...distinctServers]`.
 * When the current selection is no longer present (its server left the buffer),
 * falls back to `all`.
 */
export function nextServerFilter(current: string | "all", logs: McpLogEntry[]): string | "all" {
  const cycle: Array<string | "all"> = ["all", ...distinctServers(logs)]
  const i = cycle.indexOf(current)
  if (i === -1) return "all"
  return cycle[(i + 1) % cycle.length]
}

/** `HH:MM:SS` for a captured line's epoch-ms timestamp. */
export function formatLogTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** One row's plain-text form (for clipboard copy / non-coloured contexts). */
export function formatLogRow(entry: McpLogEntry): string {
  const server = entry.server ? ` [${entry.server}]` : ""
  return `${formatLogTime(entry.ts)} ${levelLabel(entry.level).trim()}${server} ${entry.message}`
}

/** Join filtered rows into a copy-to-clipboard blob. */
export function formatLogsForCopy(logs: McpLogEntry[]): string {
  return logs.map(formatLogRow).join("\n")
}

/** One server's status for the panel header summary. */
export interface ServerStatusLite {
  name: string
  /** The probe status (`connected` / `failed` / `needs_auth` / `disabled` /
   * `pending`) — accepted as a plain string so callers needn't import the
   * probe's union. */
  status: string
}

/** Glyph for a server status in the header summary. */
function statusGlyph(status: string): string {
  switch (status) {
    case "connected":
      return "✓"
    case "failed":
      return "✗"
    case "needs_auth":
      return "⚠"
    case "disabled":
      return "○"
    default:
      return "…"
  }
}

/** A compact `✓ github  ✗ db  ○ fs` server-status line for the panel header.
 * Empty when there are no servers. */
export function formatServerStatusSummary(servers: ServerStatusLite[]): string {
  if (servers.length === 0) return ""
  return servers.map((s) => `${statusGlyph(s.status)} ${s.name}`).join("  ")
}

/** A one-line summary of the current filter state for the panel header. */
export function describeFilter(filter: McpLogFilter, total: number, shown: number): string {
  const bits: string[] = [`${shown}/${total}`]
  if (filter.level !== "all") bits.push(`level:${filter.level}`)
  if (filter.server !== "all") bits.push(`server:${filter.server}`)
  if (filter.query.trim()) bits.push(`“${filter.query.trim()}”`)
  return bits.join(" · ")
}

/** Coerce an arbitrary level token to a known {@link McpLogLevel} (defaults to
 * `info`). Accepts the `warning` alias emitted by some servers. */
export function coerceLevel(v: unknown): McpLogLevel {
  if (typeof v === "string") {
    const l = v.toLowerCase()
    if (l === "warning") return "warn"
    if (l === "error" || l === "warn" || l === "info" || l === "debug") return l
  }
  return "info"
}

const MCP_LOG_SOURCES: McpLogSource[] = ["stderr", "diagnostic", "sidecar", "status"]

/**
 * Map a raw sidecar stdout message to a captured MCP log entry (sans `id`, which
 * the reducer stamps), or null when the message isn't a log we surface. Handles
 * the structured `mcp_log` event (stderr / connect-tool diagnostics / status)
 * and the generic `log` stream (tagged `source: "sidecar"`). Pure — the clock is
 * injected so it unit-tests deterministically.
 */
export function sidecarEventToMcpLog(
  payload: unknown,
  now: () => number
): Omit<McpLogEntry, "id"> | null {
  if (!payload || typeof payload !== "object") return null
  const p = payload as Record<string, unknown>
  const message = p.message
  if (p.type === "mcp_log") {
    if (typeof message !== "string") return null
    const source = MCP_LOG_SOURCES.includes(p.source as McpLogSource)
      ? (p.source as McpLogSource)
      : "stderr"
    return {
      ts: typeof p.ts === "number" ? p.ts : now(),
      level: coerceLevel(p.level),
      message,
      source,
      ...(typeof p.server === "string" && p.server ? { server: p.server } : {}),
    }
  }
  if (p.type === "log") {
    // The generic sidecar log stream — not MCP-specific, but the user opted to
    // surface it in the same panel. Empty messages are dropped as noise.
    if (typeof message !== "string" || !message.trim()) return null
    return { ts: now(), level: coerceLevel(p.level), message, source: "sidecar" }
  }
  return null
}

export const MCP_LOG_PANEL_FOOTER =
  "type filter · ↑/↓ scroll · Tab level · ⇧Tab server · ^F follow · ^L clear · ^Y copy · esc close"
