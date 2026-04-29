// Cline (VS Code extension). The config lives in VS Code's globalStorage,
// at a path that depends on the VS Code distribution and is not officially
// guaranteed stable. Cognia probes the conventional locations on read but
// will NOT write — sync semantics are too fragile. The chip stays
// read-only in the UI.
//
// Schema (per docs.cline.bot): the same `mcpServers` map as the rest of the
// JSON-based agents, with a couple of extra fields we round-trip but don't
// otherwise interpret: `alwaysAllow: string[]`, `disabled: boolean`.

import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { dropInvalidDrafts, normalizeMcpEntry } from "./shared"

interface RawClineConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawClineConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawClineConfig
}

function parse(value: unknown): McpImportDraft[] {
  const root = asRoot(value)
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return []
  const out: McpImportDraft[] = []
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    const norm = normalizeMcpEntry(raw)
    if (!norm) continue
    // Cline's `disabled: true` semantically maps to our `enabled: false` for
    // the projected target — but since cline is read-only, we only carry it
    // through metadata-style: it doesn't override the import.
    out.push({ name, transport: norm.transport, config: norm.config })
  }
  return dropInvalidDrafts(out)
}

function project(): unknown {
  throw new Error(
    "cline is read-only — globalStorage path is not stable enough for Cognia to safely write"
  )
}

export const CLINE_AGENT: McpAgentAdapter = {
  id: "cline",
  displayName: "Cline",
  description: "VS Code extension — read-only (path varies)",
  writable: false,
  format: "json",
  parse,
  project,
}
