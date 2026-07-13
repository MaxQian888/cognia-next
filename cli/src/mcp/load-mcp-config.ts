/**
 * Load MCP server definitions from `.mcp.json` files (Claude-Code convention)
 * and synthesise `McpServer[]` rows that feed the desktop's `preloadedMcpServers`
 * build-options seam. Reuses the desktop `normalizeMcpEntry` parser verbatim.
 *
 * Search order (first occurrence of a name wins → project overrides global):
 *   <cwd>/.mcp.json, <cwd>/mcp.json, <cwd>/.cognia/mcp.json, ~/.cognia/mcp.json
 * The bare `<root>/mcp.json` candidate is what `/mcp add` writes to (the CLI
 * home IS the `.cognia` dir), so adding a server there actually loads.
 * Each file is either `{ "mcpServers": { name: entry } }` (standard) or a bare
 * `{ name: entry }` map.
 */
import nodeFs from "node:fs"
import path from "node:path"

import { normalizeMcpEntry } from "@/lib/claude/agents/shared"
import type { McpServer } from "@cognia/agent-config-types"

export interface McpFs {
  exists(path: string): boolean
  readText(path: string): string
}

const defaultFs: McpFs = {
  exists: (p) => nodeFs.existsSync(p),
  readText: (p) => nodeFs.readFileSync(p, "utf8"),
}

/** Candidate config files for a set of roots, in precedence order. */
export function mcpConfigPaths(roots: string[]): string[] {
  const out: string[] = []
  for (const root of roots) {
    out.push(path.join(root, ".mcp.json"))
    out.push(path.join(root, "mcp.json"))
    out.push(path.join(root, ".cognia", "mcp.json"))
  }
  return out
}

function entriesOf(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object") return {}
  const obj = parsed as Record<string, unknown>
  if (obj.mcpServers && typeof obj.mcpServers === "object") {
    return obj.mcpServers as Record<string, unknown>
  }
  return obj
}

/** Parse one config file's text into McpServer rows (all enabled). */
export function parseMcpConfig(text: string): McpServer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const rows: McpServer[] = []
  for (const [name, raw] of Object.entries(entriesOf(parsed))) {
    const normalized = normalizeMcpEntry(raw)
    if (!normalized) continue
    rows.push({
      id: `mcp_${name}`,
      name,
      transport: normalized.transport,
      config: normalized.config,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    })
  }
  return rows
}

/** Load + merge MCP servers across the candidate files (first name wins). */
export function loadMcpServers(roots: string[], fs: McpFs = defaultFs): McpServer[] {
  const byName = new Map<string, McpServer>()
  for (const file of mcpConfigPaths(roots)) {
    if (!fs.exists(file)) continue
    let text: string
    try {
      text = fs.readText(file)
    } catch {
      continue
    }
    for (const row of parseMcpConfig(text)) {
      if (!byName.has(row.name)) byName.set(row.name, row)
    }
  }
  return [...byName.values()]
}
