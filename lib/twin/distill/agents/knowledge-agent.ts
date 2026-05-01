/**
 * KnowledgeAgent — extract entities + per-chunk tags from a batch.
 */

import { extractJson, type LlmClient } from "../llm"
import { applyTemplate, KNOWLEDGE_AGENT_PROMPT } from "../prompts"
import type { EntityRole, ProfileEntity, TwinChunk } from "@/types/twin"

export interface KnowledgeAgentInput {
  chunks: TwinChunk[]
  /** Cap chunks per call. The orchestrator splits big batches itself. */
  maxChunks?: number
}

export interface KnowledgeAgentResult {
  entities: ProfileEntity[]
  /** chunkId → entity names; consumed by the orchestrator to backfill `entityTags`. */
  perChunk: Record<string, string[]>
}

interface RawEntity {
  name?: string
  aliases?: string[]
  role?: string
  relation?: string
  firstSeenChunkId?: string
}

interface RawPerChunk {
  chunkId?: string
  entityNames?: string[]
}

const VALID_ROLES: ReadonlySet<EntityRole> = new Set([
  "person",
  "team",
  "project",
  "system",
  "concept",
])

function formatChunksForPrompt(chunks: TwinChunk[]): string {
  return chunks.map((c) => `[${c.id}]\n${c.contentRedacted}`).join("\n\n---\n\n")
}

export async function runKnowledgeAgent(
  llm: LlmClient,
  input: KnowledgeAgentInput
): Promise<KnowledgeAgentResult> {
  const cap = input.maxChunks ?? 100
  const chunks = input.chunks.slice(0, cap)
  if (chunks.length === 0) return { entities: [], perChunk: {} }

  const prompt = applyTemplate(KNOWLEDGE_AGENT_PROMPT, {
    chunks: formatChunksForPrompt(chunks),
  })

  const response = await llm.complete(prompt, { temperature: 0, maxTokens: 3500 })
  const parsed = extractJson<{
    entities?: RawEntity[]
    perChunk?: RawPerChunk[]
  }>(response)
  const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : []
  const rawPerChunk = Array.isArray(parsed.perChunk) ? parsed.perChunk : []

  const validChunkIds = new Set(chunks.map((c) => c.id))

  const entities: ProfileEntity[] = rawEntities
    .map((raw): ProfileEntity | null => {
      if (!raw.name) return null
      const role =
        raw.role && VALID_ROLES.has(raw.role as EntityRole) ? (raw.role as EntityRole) : "concept"
      const firstSeen =
        typeof raw.firstSeenChunkId === "string" && validChunkIds.has(raw.firstSeenChunkId)
          ? raw.firstSeenChunkId
          : chunks[0].id
      return {
        name: raw.name.trim(),
        aliases: Array.isArray(raw.aliases)
          ? raw.aliases.filter((a): a is string => typeof a === "string")
          : [],
        role,
        relation: raw.relation?.trim() || undefined,
        firstSeenChunkId: firstSeen,
      }
    })
    .filter((e): e is ProfileEntity => e !== null)

  const perChunk: Record<string, string[]> = {}
  for (const row of rawPerChunk) {
    if (!row.chunkId || !validChunkIds.has(row.chunkId)) continue
    const names = Array.isArray(row.entityNames)
      ? row.entityNames.filter((n): n is string => typeof n === "string")
      : []
    if (names.length > 0) perChunk[row.chunkId] = names
  }

  return { entities, perChunk }
}
