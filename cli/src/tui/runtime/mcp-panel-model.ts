/**
 * Pure presentation model for the interactive `/mcp` panel. Maps the backend's
 * four probe states (+ a UI-only `pending` while a probe is in flight) to a
 * one-glance coloured-bullet badge, an inline "how to fix" affordance, and a
 * fuzzy filter. Kept Ink-free so the whole status taxonomy unit-tests without a
 * render. The component (`components/McpPanel.tsx`) owns only the live query and
 * highlight; everything visible flows from here.
 */
import type { McpServerStatus } from "../../mcp/probe-mcp-server"
import { fuzzyFilter } from "./fuzzy-filter"

/** A server's status as the panel shows it — the probe's four states plus a
 * `pending` placeholder shown while the async probe has not yet resolved. */
export type McpPanelStatus = McpServerStatus | "pending"

/** One row in the server list. `status` mutates live as probes resolve. */
export interface McpPanelServer {
  name: string
  transport: string
  /** Whether the server is enabled (the `/mcp disable` overlay is off). */
  enabled: boolean
  status: McpPanelStatus
  /** Connection error detail for a `failed` row (shown in the fix hint). */
  error?: string
  /** Tool count once known (from a successful probe). */
  toolCount?: number
}

/** One row in a server's per-tool toggle list. */
export interface McpPanelTool {
  /** The bare tool name (as advertised by the server). */
  name: string
  description?: string
  /** Whether the tool is currently enabled (not in the disabled overlay). */
  enabled: boolean
}

/** A palette token name (see `theme/palette.ts`) + a bullet glyph for a status. */
export interface McpStatusBadge {
  glyph: string
  label: string
  /** Key into the theme palette — `success` / `warning` / `danger` / `muted` / `info`. */
  token: "success" | "warning" | "danger" | "muted" | "info"
}

const STATUS_BADGE: Record<McpPanelStatus, McpStatusBadge> = {
  connected: { glyph: "●", label: "connected", token: "success" },
  needs_auth: { glyph: "●", label: "needs auth", token: "warning" },
  failed: { glyph: "●", label: "failed", token: "danger" },
  disabled: { glyph: "○", label: "disabled", token: "muted" },
  pending: { glyph: "◌", label: "connecting…", token: "info" },
}

/** The coloured-bullet badge for a status. A disabled server always reads as
 * `disabled` regardless of its last probe. */
export function statusBadge(server: McpPanelServer): McpStatusBadge {
  if (!server.enabled) return STATUS_BADGE.disabled
  return STATUS_BADGE[server.status]
}

/**
 * A short, self-documenting affordance telling the user how to act on a row —
 * the OpenCode/Crush "print the exact fix inline" pattern. Returns null when the
 * row needs no action (a healthy connected server).
 */
export function fixHint(server: McpPanelServer): string | null {
  if (!server.enabled) return "space enables"
  switch (server.status) {
    case "needs_auth":
      return "enter authorizes"
    case "failed":
      return server.error ? `enter reconnects · ${truncate(server.error, 40)}` : "enter reconnects"
    case "pending":
      return null
    case "connected":
      return server.toolCount != null ? `${server.toolCount} tools · enter` : "enter for tools"
    case "disabled":
      return "space enables"
  }
}

/**
 * What pressing Enter on a row does, given its status — the context-sensitive
 * primary action (so single-letter keys stay free for the filter box):
 *  - connected → open the per-tool list
 *  - needs_auth → run the OAuth flow
 *  - failed → reconnect (re-probe)
 *  - disabled → enable
 *  - pending → nothing (probe in flight)
 */
export type McpEnterAction = "tools" | "auth" | "reconnect" | "enable" | "none"

export function enterAction(server: McpPanelServer): McpEnterAction {
  if (!server.enabled) return "enable"
  switch (server.status) {
    case "connected":
      return "tools"
    case "needs_auth":
      return "auth"
    case "failed":
      return "reconnect"
    case "disabled":
      return "enable"
    case "pending":
      return "none"
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/** Fuzzy-filter the server list by name (empty query keeps original order). */
export function filterMcpServers(servers: McpPanelServer[], query: string): McpPanelServer[] {
  return fuzzyFilter(servers, query, (s) => s.name)
}

/** Fuzzy-filter a server's tools by name + description. */
export function filterMcpTools(tools: McpPanelTool[], query: string): McpPanelTool[] {
  return fuzzyFilter(tools, query, (t) => [t.name, t.description ?? ""])
}

/** Patch one server's live status fields into the list (by name), immutably.
 * Used by the controller's async probe as each server resolves. */
export function patchServerStatus(
  servers: McpPanelServer[],
  name: string,
  patch: Partial<Pick<McpPanelServer, "status" | "error" | "toolCount" | "enabled">>
): McpPanelServer[] {
  return servers.map((s) => (s.name === name ? { ...s, ...patch } : s))
}

export const MCP_PANEL_FOOTER =
  "type filter · ↑/↓ / click · enter act · space toggle · ^N new · ^X remove · esc close"

export const MCP_TOOLS_FOOTER = "type filter · ↑/↓ / click · space toggle · esc back"
