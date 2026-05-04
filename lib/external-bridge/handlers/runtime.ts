/**
 * MCP tool handler — `runtime_query`.
 *
 * Lets external agents inspect Cognia's runtime entities (skills,
 * characters, twins, plugins, agent-teams). Two ops:
 *   • `op: "list"`   — returns minimal summaries (id, name, kind-specific meta)
 *   • `op: "get"`    — returns the full entity for a single id
 *
 * Return shapes are *intentionally* lossy compared to the full Dexie row:
 * we drop large fields (e.g. `Skill.content`, full prompt bodies) on
 * `list` to keep the tools/list response small. `get` returns the full
 * row.
 *
 * The handler does NOT consult the permission gate — that lives one layer
 * up in the MCP server skeleton, which calls `checkRuntimeCall` per
 * `entityType` before dispatching here.
 */

import { listSkills, getSkill } from "@/lib/db/skills"
import { listCharacters, getCharacter } from "@/lib/db/characters"
import { listTeams, getTeam } from "@/lib/db/teams"
import { listPlugins, getPlugin } from "@/lib/db/plugins"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"

export type RuntimeEntityType = "skill" | "character" | "twin" | "plugin" | "agent-team"

export interface RuntimeQueryInput {
  entityType: RuntimeEntityType
  op: "list" | "get"
  /** Required for `op: "get"` — the entity id. */
  id?: string
  /** Reserved for future filter narrowing on `op: "list"`. */
  filter?: Record<string, unknown>
}

export interface RuntimeListEntry {
  id: string
  /** Name shown in the agent's UI. */
  name: string
  /** Free-form one-liner suitable for tool responses. */
  description?: string
  /** Tags / category / source — entity-specific. */
  meta: Record<string, unknown>
}

export type RuntimeQueryOutput =
  | { entityType: RuntimeEntityType; op: "list"; entries: RuntimeListEntry[] }
  | { entityType: RuntimeEntityType; op: "get"; entity: Record<string, unknown> | undefined }

export async function runtimeQuery(input: RuntimeQueryInput): Promise<RuntimeQueryOutput> {
  if (input.op === "list") {
    return {
      entityType: input.entityType,
      op: "list",
      entries: await listEntries(input.entityType),
    }
  }
  const entity = await fetchOne(input.entityType, input.id)
  return { entityType: input.entityType, op: "get", entity }
}

async function listEntries(entityType: RuntimeEntityType): Promise<RuntimeListEntry[]> {
  switch (entityType) {
    case "skill": {
      const rows = await listSkills()
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        meta: {
          isBuiltIn: r.isBuiltIn,
          category: r.category,
          source: r.source,
          status: r.status,
          tags: r.tags,
          updatedAt: r.updatedAt,
        },
      }))
    }
    case "character": {
      const rows = await listCharacters()
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        meta: { isBuiltIn: r.isBuiltIn, updatedAt: r.updatedAt },
      }))
    }
    case "agent-team": {
      const rows = await listTeams()
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        meta: { isBuiltIn: r.isBuiltIn, memberCount: r.members?.length ?? 0 },
      }))
    }
    case "plugin": {
      const rows = await listPlugins()
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        meta: {
          version: r.version,
          status: r.status,
          source: r.source,
          enabled: r.enabled,
          capabilities: r.capabilities,
        },
      }))
    }
    case "twin": {
      // Twin "list" surfaces the unique twinIds across `twinSources` rows.
      // We don't have a `twins` table — twinId is the implicit key.
      const seen = new Set<string>()
      // Best-effort: walk known character.twinId values via a quick listing.
      // For Phase 1 we return nothing if no characters declared a twinId;
      // a real `twins` index lands with Phase 4 inbound write tools.
      const characters = await listCharacters()
      for (const c of characters) {
        if (c.twinId) seen.add(c.twinId)
      }
      return Array.from(seen).map((twinId) => ({
        id: twinId,
        name: twinId,
        meta: { kind: "twin" },
      }))
    }
    default:
      return []
  }
}

async function fetchOne(
  entityType: RuntimeEntityType,
  id: string | undefined
): Promise<Record<string, unknown> | undefined> {
  if (!id || id.trim().length === 0) return undefined
  switch (entityType) {
    case "skill":
      return (await getSkill(id)) as unknown as Record<string, unknown> | undefined
    case "character":
      return (await getCharacter(id)) as unknown as Record<string, unknown> | undefined
    case "agent-team":
      return (await getTeam(id)) as unknown as Record<string, unknown> | undefined
    case "plugin":
      return (await getPlugin(id)) as unknown as Record<string, unknown> | undefined
    case "twin": {
      const sources = await listTwinSourcesByTwin(id)
      if (sources.length === 0) return undefined
      return {
        twinId: id,
        sourceCount: sources.length,
        sources: sources.map((s) => ({
          id: s.id,
          format: s.format,
          status: s.status,
          title: s.title,
          importedAt: s.importedAt,
        })),
      }
    }
    default:
      return undefined
  }
}

export const __TESTING__ = { listEntries, fetchOne }
