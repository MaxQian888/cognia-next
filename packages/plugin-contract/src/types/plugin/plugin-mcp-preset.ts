/**
 * Plugin MCP Server Preset Definitions
 *
 * Plugins contributing the `mcp-server-preset` capability ship one or more
 * `PluginMcpServerPresetDef` entries through their manifest. These show up
 * in the MCP gallery alongside the static `MCP_PRESETS` table — the only
 * runtime difference is a `runtime` discriminator that lets plugins target
 * a specific agent runtime (Claude Code SDK sidecar vs. Vercel ai-sdk
 * runner) when a preset only makes sense for one of them.
 */

import type { McpPresetField } from "@/lib/claude/mcp-presets"
import type { McpTransport } from "@cognia/agent-config-types"

export interface PluginMcpServerPresetDef {
  /** Unique id (kebab-case, e.g. "playwright"). */
  id: string
  /** Display name shown in the MCP gallery card. */
  name: string
  /** One- or two-line description. */
  description?: string
  /** Emoji or short glyph (1-2 chars). */
  icon?: string
  /** stdio | http | sse — same union as the static MCP_PRESETS table. */
  transport: McpTransport
  /** Transport-specific config — same shape as McpPreset.config. */
  config: Record<string, unknown>
  /** Fields the user must fill (env vars, URL, headers, arg replacements). */
  fields?: McpPresetField[]
  /** Bare MCP tool names denied when a server row is created from this preset. */
  defaultDisallowedTools?: string[]
  /**
   * Which agent runtime this preset is intended for:
   * - "sdk":    Claude Code SDK sidecar path only
   * - "ai-sdk": Vercel ai-sdk runner only
   * - "both":   either runtime (default)
   */
  runtime?: "sdk" | "ai-sdk" | "both"
  /** Canonical docs URL. */
  docsUrl?: string
  /** Tags for filtering the gallery (e.g. ["web", "browser"]). */
  tags?: string[]
  /** Optional host-managed lifecycle; omitted presets remain manual templates. */
  provisioning?: {
    mode: "template" | "managed"
    serviceId?: string
    providerId?: string
    installScope?: "account"
    connectMode?: "explicit"
  }
  /** Reviewed tool-risk overlay. Unmatched discovered tools remain ask/deny. */
  toolRiskRules?: Array<{
    pattern: string
    risk: "read" | "write" | "destructive"
    operationId?: string
    selectors?: Array<{ kind: string; jsonPointer: string }>
  }>
}
