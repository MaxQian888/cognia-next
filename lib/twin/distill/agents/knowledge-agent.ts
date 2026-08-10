/**
 * KnowledgeAgent — extract entities + per-chunk tags from a batch.
 */

import { extractJson, type LlmClient } from "../llm"
import { applyTemplate, KNOWLEDGE_AGENT_PROMPT } from "../prompts"
import type { DecisionRecord, EntityRole, ProfileEntity, TwinChunk } from "@/types/twin"

export interface KnowledgeAgentInput {
  chunks: TwinChunk[]
  /** Cap chunks per call. The orchestrator splits big batches itself. */
  maxChunks?: number
}

export interface KnowledgeAgentResult {
  entities: ProfileEntity[]
  decisions: DecisionRecord[]
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

interface RawDecision {
  context?: string
  choice?: string
  rationale?: string
  sourceChunkIds?: string[]
  timestamp?: number
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

function decisionId(context: string, choice: string): string {
  const input = `${context.trim().toLowerCase()}::${choice.trim().toLowerCase()}`
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `decision_${(hash >>> 0).toString(36)}`
}

export async function runKnowledgeAgent(
  llm: LlmClient,
  input: KnowledgeAgentInput
): Promise<KnowledgeAgentResult> {
  const cap = input.maxChunks ?? 100
  const chunks = input.chunks.slice(0, cap)
  if (chunks.length === 0) return { entities: [], decisions: [], perChunk: {} }

  const prompt = applyTemplate(KNOWLEDGE_AGENT_PROMPT, {
    chunks: formatChunksForPrompt(chunks),
  })

  const response = await llm.complete(prompt, { temperature: 0, maxTokens: 3500 })
  const parsed = extractJson<{
    entities?: RawEntity[]
    perChunk?: RawPerChunk[]
    decisions?: RawDecision[]
  }>(response)
  const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : []
  const rawPerChunk = Array.isArray(parsed.perChunk) ? parsed.perChunk : []
  const rawDecisions = Array.isArray(parsed.decisions) ? parsed.decisions : []

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

  const decisions: DecisionRecord[] = rawDecisions.flatMap((raw) => {
    const context = raw.context?.trim()
    const choice = raw.choice?.trim()
    if (!context || !choice) return []
    const sourceChunkIds = Array.isArray(raw.sourceChunkIds)
      ? raw.sourceChunkIds.filter((id): id is string => validChunkIds.has(id))
      : []
    return [
      {
        id: decisionId(context, choice),
        context,
        choice,
        rationale: raw.rationale?.trim() ?? "",
        sourceChunkIds: sourceChunkIds.length > 0 ? sourceChunkIds : [chunks[0].id],
        ...(typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp)
          ? { timestamp: raw.timestamp }
          : {}),
      },
    ]
  })

  return { entities, decisions, perChunk }
}
