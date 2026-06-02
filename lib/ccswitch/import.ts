// Adapters that turn CCSwitch table rows into cognia-next's existing import
// shapes, then delegate to the existing per-domain import paths. We never
// add a parallel storage table for CCSwitch entries — the destination is
// always cognia-next's own `mcpServers` / `promptPresets` / `skills` tables.

import type { McpImportDraft, McpImportStrategy } from "@/lib/db/mcp-servers"
import { bulkImportMcpServers } from "@/lib/db/mcp-servers"
import { createPreset } from "@/lib/db/prompt-presets"
import { createSkill } from "@/lib/db/skills"
import { listSkills } from "@/lib/db/skills"
import type { McpTransport } from "@/lib/claude/types"

import type { CcswitchMcpServer, CcswitchPrompt, CcswitchSkill } from "@/types/ccswitch"

/* ---- MCP servers ------------------------------------------------------- */

const VALID_TRANSPORTS: McpTransport[] = ["stdio", "sse", "http"]

function pickTransport(raw: unknown): McpTransport {
  if (typeof raw === "string") {
    const lower = raw.toLowerCase()
    if ((VALID_TRANSPORTS as string[]).includes(lower)) return lower as McpTransport
  }
  return "stdio"
}

/**
 * CCSwitch stores the MCP config as either a parsed object (`config: {...}`)
 * or a stringified JSON. Tolerate both.
 */
function configAsObject(value: CcswitchMcpServer["config"]): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export function fromCcswitchMcp(server: CcswitchMcpServer): McpImportDraft {
  const cfg = configAsObject(server.config)
  // CCSwitch tends to embed the transport in the config blob too; the
  // top-level field wins when present, otherwise inspect the blob.
  const transport = pickTransport(server.transport ?? cfg.type ?? cfg.transport)
  // Strip the duplicate transport hint so it doesn't double-up in cognia's
  // McpServer.config (which forwards as-is to the SDK). The leading-underscore
  // names mark the destructured aliases as intentionally unused.
  const { type: _t, transport: _u, ...rest } = cfg
  void _t
  void _u
  return {
    name: server.name.trim(),
    transport,
    config: rest,
  }
}

export interface McpImportSummary {
  imported: number
  updated: number
  skipped: number
  errored: Array<{ name: string; error: string }>
}

export async function importCcswitchMcp(
  selected: CcswitchMcpServer[],
  strategy: McpImportStrategy = "skip"
): Promise<McpImportSummary> {
  const drafts = selected.map(fromCcswitchMcp).filter((d) => d.name.length > 0)
  const result = await bulkImportMcpServers(drafts, strategy)
  return {
    imported: result.created,
    updated: result.updated,
    skipped: result.skipped,
    errored: result.errored,
  }
}

/* ---- Prompts ----------------------------------------------------------- */

export interface PromptImportSummary {
  imported: number
  errored: Array<{ name: string; error: string }>
}

/**
 * Each CCSwitch prompt becomes a fresh cognia-next prompt preset. Built-in
 * cognia-next presets are never touched; collisions on user-created names
 * are not de-duped (the user can rename later — preset names aren't unique).
 */
export async function importCcswitchPrompts(
  selected: CcswitchPrompt[]
): Promise<PromptImportSummary> {
  const summary: PromptImportSummary = { imported: 0, errored: [] }
  for (const p of selected) {
    const name = p.name.trim()
    const content = p.content.trim()
    if (!name || !content) {
      summary.errored.push({
        name: name || "(unnamed)",
        error: "missing name or content",
      })
      continue
    }
    try {
      await createPreset({
        name,
        content,
        description: p.description,
        category: "general",
      })
      summary.imported += 1
    } catch (err) {
      summary.errored.push({
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return summary
}

/* ---- Skills ------------------------------------------------------------ */

export interface SkillImportSummary {
  imported: number
  skipped: Array<{ name: string; reason: string }>
  errored: Array<{ name: string; error: string }>
}

/**
 * Each CCSwitch skill becomes a fresh cognia-next skill row.
 *   - Skills with no body (`content` empty) are skipped — CCSwitch was
 *     pointing at an external file and cognia-next stores skill markdown
 *     inline; the user must re-import via the Skills section to materialize
 *     a proper cognia-native skill.
 *   - Name collisions are skipped to mirror MCP "existing wins" semantics.
 */
export async function importCcswitchSkills(selected: CcswitchSkill[]): Promise<SkillImportSummary> {
  const summary: SkillImportSummary = {
    imported: 0,
    skipped: [],
    errored: [],
  }
  const existing = await listSkills()
  const byName = new Set(existing.map((s) => s.name.trim().toLowerCase()))

  for (const s of selected) {
    const name = s.name.trim()
    if (!name) {
      summary.errored.push({ name: "(unnamed)", error: "missing name" })
      continue
    }
    if (!s.content?.trim()) {
      summary.skipped.push({
        name,
        reason: "external file — re-import via Skills section",
      })
      continue
    }
    if (byName.has(name.toLowerCase())) {
      summary.skipped.push({ name, reason: "name already in use" })
      continue
    }
    try {
      await createSkill({
        name,
        content: s.content,
        description: s.description,
        source: "custom",
        status: "enabled",
      })
      byName.add(name.toLowerCase())
      summary.imported += 1
    } catch (err) {
      summary.errored.push({
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return summary
}
