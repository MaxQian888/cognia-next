// Helpers shared across agent adapters. Most agents store MCP entries as
// `{ [name]: { type?, command?, args?, env?, url?, headers?, ... } }`, with a
// few quirks: VS Code uses `servers` instead of `mcpServers`, Windsurf uses
// `serverUrl`, Gemini splits SSE / HTTP via `url` vs `httpUrl`, etc. The
// adapter that owns the file knows about these — this module just provides
// the canonical normalize/denormalize used when shapes match.

import type { McpTransport } from "@cognia/agent-config-types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"

/**
 * Inspect a parsed MCP entry and return our canonical {transport, config}
 * pair. Forgiving: returns null if the entry is so malformed we can't pin a
 * transport. Strips the agent's own `type`/`transport` discriminator from the
 * config so we can re-stamp it cleanly on serialize.
 */
export function normalizeMcpEntry(
  raw: unknown,
  opts: {
    /** Which key holds the URL on this agent (default `url`). Windsurf: `serverUrl`. */
    urlKey?: string
    /** Override transport derivation (e.g. claude-desktop is stdio-only). */
    forceTransport?: McpTransport
  } = {}
): { transport: McpTransport; config: Record<string, unknown> } | null {
  if (!raw || typeof raw !== "object") return null
  const cfg = { ...(raw as Record<string, unknown>) }

  const urlKey = opts.urlKey ?? "url"
  const explicitType = cfg.type ?? cfg.transport

  let transport: McpTransport
  if (opts.forceTransport) {
    transport = opts.forceTransport
  } else if (explicitType === "stdio" || explicitType === "sse" || explicitType === "http") {
    transport = explicitType
  } else if (explicitType === "streamable-http") {
    // Roo Code calls it streamable-http; fold into our http transport.
    transport = "http"
  } else if (typeof cfg.httpUrl === "string") {
    // Gemini quirk.
    transport = "http"
    cfg.url = cfg.httpUrl
    delete cfg.httpUrl
  } else if (typeof cfg[urlKey] === "string") {
    // Heuristic: a remote endpoint without explicit type is HTTP. Most agents
    // default this way; SSE is rarer and usually marked.
    transport = "http"
    if (urlKey !== "url") {
      // Normalize alternate URL keys (windsurf serverUrl) to canonical `url`.
      cfg.url = cfg[urlKey]
      delete cfg[urlKey]
    }
  } else if (typeof cfg.command === "string") {
    transport = "stdio"
  } else {
    return null
  }

  // Drop the discriminator — we re-stamp it from `transport` on serialize so
  // it can never drift out of sync with the actual config shape.
  delete cfg.type
  delete cfg.transport

  return { transport, config: cfg }
}

/**
 * Inverse of `normalizeMcpEntry`. Produce the on-disk shape for a single
 * server entry on the given agent.
 */
export function denormalizeMcpEntry(
  transport: McpTransport,
  config: Record<string, unknown>,
  opts: {
    /** Which key the agent stamps the type into. null = omit (claude-desktop). */
    typeKey?: "type" | null
    /** Which key the agent uses for URL (windsurf: serverUrl). */
    urlKey?: string
    /**
     * Gemini-style splitter: writes SSE servers under `url` and HTTP servers
     * under `httpUrl`. Mutually exclusive with `urlKey`.
     */
    geminiUrlSplit?: boolean
  } = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config }
  const typeKey = opts.typeKey === undefined ? "type" : opts.typeKey

  if (transport === "stdio") {
    if (typeKey) out[typeKey] = "stdio"
  } else if (opts.geminiUrlSplit) {
    // Gemini: stdio uses `command`, SSE uses `url`, HTTP uses `httpUrl`.
    // Don't stamp a type key.
    if (transport === "http" && typeof out.url === "string") {
      out.httpUrl = out.url
      delete out.url
    }
  } else {
    if (typeKey) out[typeKey] = transport
    const urlKey = opts.urlKey ?? "url"
    if (urlKey !== "url" && typeof out.url === "string") {
      out[urlKey] = out.url
      delete out.url
    }
  }

  return out
}

/**
 * Filter a list of import drafts to those Cognia would accept. Drops entries
 * with empty names and (for stdio) entries with no command. Used so adapters
 * don't need to repeat this check.
 */
export function dropInvalidDrafts(drafts: McpImportDraft[]): McpImportDraft[] {
  return drafts.filter((d) => {
    if (!d.name?.trim()) return false
    if (d.transport === "stdio" && typeof d.config.command !== "string") {
      return false
    }
    if (d.transport !== "stdio" && typeof d.config.url !== "string") {
      return false
    }
    return true
  })
}
