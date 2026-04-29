// Gemini CLI. ~/.gemini/settings.json — also has app-wide settings, so we
// must not blow other keys away on write. Transport is field-discriminated:
//   - `command` present → stdio
//   - `url` present     → SSE
//   - `httpUrl` present → streamable HTTP
//
// We collapse SSE into our `sse` transport and HTTP into our `http`. On
// write we always re-stamp the URL into the right field key based on the
// canonical transport.

import type { McpServer } from "@/lib/claude/types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { dropInvalidDrafts, normalizeMcpEntry } from "./shared"

interface RawGeminiConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawGeminiConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawGeminiConfig
}

function parse(value: unknown): McpImportDraft[] {
  const root = asRoot(value)
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return []
  const out: McpImportDraft[] = []
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    if (!raw || typeof raw !== "object") continue
    const cfg = raw as Record<string, unknown>
    if (typeof cfg.command === "string") {
      const norm = normalizeMcpEntry(cfg, { forceTransport: "stdio" })
      if (norm) out.push({ name, transport: norm.transport, config: norm.config })
    } else if (typeof cfg.url === "string") {
      // Gemini's `url` is SSE specifically.
      const norm = normalizeMcpEntry(cfg, { forceTransport: "sse" })
      if (norm) out.push({ name, transport: norm.transport, config: norm.config })
    } else if (typeof cfg.httpUrl === "string") {
      // Canonicalize httpUrl → url for our internal draft so the rest of the
      // pipeline sees the same shape regardless of which agent it came from.
      const canonical: Record<string, unknown> = { ...cfg, url: cfg.httpUrl }
      delete canonical.httpUrl
      const norm = normalizeMcpEntry(canonical, { forceTransport: "http" })
      if (norm) out.push({ name, transport: norm.transport, config: norm.config })
    }
  }
  return dropInvalidDrafts(out)
}

function emit(server: McpServer): Record<string, unknown> {
  const cfg = { ...server.config }
  if (server.transport === "stdio") {
    return cfg
  }
  if (server.transport === "sse") {
    // url already canonical
    return cfg
  }
  // http → write under httpUrl
  if (typeof cfg.url === "string") {
    cfg.httpUrl = cfg.url
    delete cfg.url
  }
  return cfg
}

function project(
  existing: unknown | null,
  servers: McpServer[],
  managedNames?: ReadonlySet<string>
): unknown {
  const root: RawGeminiConfig = asRoot(existing) ?? {}
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name))
  const next: Record<string, unknown> = {}

  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      if (!managedSet.has(name)) next[name] = value
    }
  }

  for (const server of servers) {
    next[server.name] = emit(server)
  }

  return { ...root, mcpServers: next }
}

export const GEMINI_AGENT: McpAgentAdapter = {
  id: "gemini",
  displayName: "Gemini CLI",
  description: "~/.gemini/settings.json — url=SSE, httpUrl=HTTP",
  writable: true,
  format: "json",
  parse,
  project,
}
