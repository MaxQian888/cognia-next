/**
 * Cross-batch entity merge agent (M3).
 *
 * The orchestrator batches the KnowledgeAgent at 100 chunks/call. Across
 * batches, the same person/team/project can surface under different
 * names (e.g. "Eng-Infra" + "Infrastructure" + "infra team") that the
 * per-batch `dedupeEntitiesByName` (lowercased-name match) can't bridge.
 * This agent gets the full deduped list, asks the LLM "which of these
 * are aliases for the same entity?", and folds the cluster into one
 * canonical row with `aliases[]` carrying the variants.
 *
 * Skipped when:
 *   • the entity pool is small enough that collisions are unlikely
 *     (< MERGE_MIN_BUCKET per role bucket)
 *   • the role bucket has every entity already linked by alias
 *
 * Cheap LLM call: temperature 0, ~2k tokens output, one call per role
 * bucket (5 buckets total). Single-shot, no retries.
 */

import { extractJson, type LlmClient } from "../llm"
import type { EntityRole, ProfileEntity } from "@/types/twin"

const MERGE_MIN_BUCKET = 6
const MAX_TOKENS = 2000

export interface EntityMergeAgentInput {
  entities: ProfileEntity[]
  /** Override the per-role minimum bucket size — used by tests. */
  minBucket?: number
}

interface RawClusterRow {
  canonical?: string
  aliases?: string[]
}

const VALID_ROLES: EntityRole[] = ["person", "team", "project", "system", "concept"]

function bucketByRole(entities: ProfileEntity[]): Record<EntityRole, ProfileEntity[]> {
  const out: Record<EntityRole, ProfileEntity[]> = {
    person: [],
    team: [],
    project: [],
    system: [],
    concept: [],
  }
  for (const entity of entities) {
    if (VALID_ROLES.includes(entity.role)) {
      out[entity.role].push(entity)
    }
  }
  return out
}

function buildClusterPrompt(role: EntityRole, entities: ProfileEntity[]): string {
  const lines = entities.map(
    (e, i) =>
      `[${i}] name="${e.name}" aliases=[${e.aliases.join(", ")}]${
        e.relation ? ` relation="${e.relation}"` : ""
      }`
  )
  return `You are normalising an entity registry of role "${role}" extracted from
chunked employee documents and chats. Group entries that refer to the
SAME real-world entity — e.g. "Engineering Infra Team" + "infra-team" +
"Eng-Infra" all map to one team.

Only merge when you have high confidence the names share a referent. Do
not merge near-misses (e.g. "Platform Team" vs "Infrastructure Platform")
unless context strongly suggests they're the same.

Output JSON of the form:
{
  "clusters": [
    { "canonical": "Engineering Infra Team", "aliases": ["infra-team", "Eng-Infra"] },
    ...
  ]
}

Entries with no merge group can be omitted. Names that share a cluster
must NOT also appear in another cluster.

Entries:
${lines.join("\n")}`
}

interface MergeClusters {
  /** name (lowercased) → canonical name. */
  canonicalOf: Map<string, string>
  /** canonical name → aliases[] (incl. canonical). */
  aliasOf: Map<string, Set<string>>
}

function buildClusters(role: EntityRole, raw: RawClusterRow[]): MergeClusters {
  const canonicalOf = new Map<string, string>()
  const aliasOf = new Map<string, Set<string>>()
  for (const cluster of raw) {
    const canonical = cluster.canonical?.trim()
    if (!canonical) continue
    const aliases = (cluster.aliases ?? [])
      .filter((a): a is string => typeof a === "string")
      .map((a) => a.trim())
      .filter((a) => a.length > 0)
    if (aliases.length === 0) continue
    const set = aliasOf.get(canonical) ?? new Set<string>([canonical])
    for (const alias of aliases) set.add(alias)
    aliasOf.set(canonical, set)
    canonicalOf.set(canonical.toLowerCase(), canonical)
    for (const alias of aliases) {
      canonicalOf.set(alias.toLowerCase(), canonical)
    }
  }
  void role // unused — bucketing happens at the caller; kept on the interface for debugging.
  return { canonicalOf, aliasOf }
}

function applyClusters(entities: ProfileEntity[], clusters: MergeClusters): ProfileEntity[] {
  const byCanonical = new Map<string, ProfileEntity>()
  const stayPut: ProfileEntity[] = []
  for (const entity of entities) {
    const canonical = clusters.canonicalOf.get(entity.name.toLowerCase())
    if (!canonical) {
      stayPut.push(entity)
      continue
    }
    const existing = byCanonical.get(canonical)
    const aliasSet = new Set<string>([
      ...(clusters.aliasOf.get(canonical) ?? []),
      ...entity.aliases,
    ])
    if (entity.name !== canonical) aliasSet.add(entity.name)
    aliasSet.delete(canonical)
    if (!existing) {
      byCanonical.set(canonical, {
        ...entity,
        name: canonical,
        aliases: Array.from(aliasSet),
      })
      continue
    }
    // Merge: keep the earliest `firstSeenChunkId`, prefer the longest
    // relation (rarely conflicting in practice).
    const mergedAliases = new Set<string>([...existing.aliases, ...aliasSet, entity.name])
    mergedAliases.delete(canonical)
    byCanonical.set(canonical, {
      ...existing,
      aliases: Array.from(mergedAliases),
      relation:
        existing.relation && entity.relation
          ? existing.relation.length >= entity.relation.length
            ? existing.relation
            : entity.relation
          : (existing.relation ?? entity.relation),
    })
  }
  return [...stayPut, ...byCanonical.values()]
}

export interface EntityMergeResult {
  merged: ProfileEntity[]
  /** Per-role counts of how many input rows the LLM folded together. */
  collapsed: Partial<Record<EntityRole, number>>
}

export async function runEntityMergeAgent(
  llm: LlmClient,
  input: EntityMergeAgentInput
): Promise<EntityMergeResult> {
  const minBucket = input.minBucket ?? MERGE_MIN_BUCKET
  const buckets = bucketByRole(input.entities)
  const collapsed: Partial<Record<EntityRole, number>> = {}
  let merged: ProfileEntity[] = []
  // Carry through entities whose role is empty / invalid — the merger
  // only touches the 5 known buckets.
  for (const entity of input.entities) {
    if (!VALID_ROLES.includes(entity.role)) merged.push(entity)
  }
  for (const role of VALID_ROLES) {
    const bucket = buckets[role]
    if (bucket.length < minBucket) {
      merged = [...merged, ...bucket]
      continue
    }
    try {
      const response = await llm.complete(buildClusterPrompt(role, bucket), {
        temperature: 0,
        maxTokens: MAX_TOKENS,
      })
      const parsed = extractJson<{ clusters?: RawClusterRow[] }>(response)
      const rawClusters = Array.isArray(parsed.clusters) ? parsed.clusters : []
      if (rawClusters.length === 0) {
        merged = [...merged, ...bucket]
        continue
      }
      const clusters = buildClusters(role, rawClusters)
      const before = bucket.length
      const mergedBucket = applyClusters(bucket, clusters)
      merged = [...merged, ...mergedBucket]
      collapsed[role] = before - mergedBucket.length
    } catch {
      // Merge failure is non-fatal — fall back to the un-merged bucket.
      merged = [...merged, ...bucket]
    }
  }
  return { merged, collapsed }
}

export const __TESTING__ = { bucketByRole, buildClusters, applyClusters, buildClusterPrompt }
