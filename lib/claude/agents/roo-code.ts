// Roo Code (VS Code extension). Like Cline, the global config path lives
// inside VS Code's globalStorage and isn't a stable contract. Read-only.
//
// Schema differences from Cline:
//   - explicit `type: "stdio" | "sse" | "streamable-http"` discriminator
//     (we fold streamable-http into our `http` transport)
//   - extra fields: `alwaysAllow`, `disabled`, `disabledTools`, `timeout`,
//     `watchPaths` — round-tripped through normalizeMcpEntry as opaque keys.

import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { dropInvalidDrafts, normalizeMcpEntry } from "./shared"

interface RawRooConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawRooConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawRooConfig
}

function parse(value: unknown): McpImportDraft[] {
  const root = asRoot(value)
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return []
  const out: McpImportDraft[] = []
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    // normalizeMcpEntry already collapses `streamable-http` → `http`.
    const norm = normalizeMcpEntry(raw)
    if (!norm) continue
    out.push({ name, transport: norm.transport, config: norm.config })
  }
  return dropInvalidDrafts(out)
}

function project(): unknown {
  throw new Error(
    "roo-code is read-only — globalStorage path is not stable enough for Cognia to safely write"
  )
}

export const ROO_CODE_AGENT: McpAgentAdapter = {
  id: "roo-code",
  displayName: "Roo Code",
  description: "VS Code extension — read-only (path varies)",
  writable: false,
  format: "json",
  parse,
  project,
}
