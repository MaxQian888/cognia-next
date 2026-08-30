/**
 * Background memory-extraction orchestrator (the per-turn write path). Fire-and-
 * forget from the chat hook after a turn completes; it must NEVER throw.
 *
 * Pipeline (gates short-circuit cheaply, left → right):
 *   enabled/autoExtract/!temporary  →  provenance (inbound excluded)
 *   →  salience heuristic (no LLM unless worth it)  →  extract (LLM)
 *   →  PII gate (hasNoLeakingPii)  →  consolidate (ADD/UPDATE/DELETE/NOOP)
 *
 * The pure orchestrator (`runMemoryExtraction`) is dependency-injected for
 * testing; `buildAutoExtractionDeps` wires the real LLM client, retriever-backed
 * similarity, Dexie persistence, and (when embeddings are configured) vector
 * upsert so recalled memories are semantically searchable.
 */

import type { ChatSession, AppSettings } from "@cognia/agent-config-types"
import type { MemoryConfig, MemoryProvenance, MemoryScope, MemoryType } from "@/types/memory/memory"
import { assessSalience } from "@/lib/memory/extract/salience"
import {
  extractMemories,
  type ExtractMemoriesInput,
  type MemoryCandidate,
} from "@/lib/memory/extract/extractor"
import {
  consolidate,
  sameMemoryNamespace,
  type ConsolidateDeps,
  type ConsolidateInput,
  type ConsolidationOp,
} from "@/lib/memory/consolidate/consolidator"
import { hasNoLeakingPii, hasNoLeakingPiiDeep, redactText } from "@cognia/redact"

export interface RunMemoryExtractionInput {
  rollingSummary?: string
  recentMessages?: { role: string; text: string }[]
  newPair: { userText: string; assistantText: string }
  scope: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  provenance: MemoryProvenance
  source?: { sessionId?: string; messageId?: string }
  config: MemoryConfig
}

export interface RunMemoryExtractionDeps {
  extract: (input: ExtractMemoriesInput) => Promise<MemoryCandidate[]>
  consolidate: (input: ConsolidateInput) => Promise<{ applied: ConsolidationOp[] }>
  /** PII gate; defaults to `hasNoLeakingPii`. */
  isPiiSafe?: (text: string) => boolean
  /** Fail-closed gate for the complete redacted payload sent to the utility LLM. */
  isPayloadPiiSafe?: (value: unknown) => boolean
  /**
   * Redact PII from the extraction inputs *before* they reach the utility LLM.
   * Defaults to the twin redactor. The extraction model can differ from the
   * conversation model the user chose, so raw turn text must not be sent to it
   * verbatim — this matches the twin "redact before send" red-line.
   */
  redact?: (text: string) => string
}

/** Auto-extract emits semantic for everyone; procedural only for trusted provenance. */
function allowedTypes(provenance: MemoryProvenance): MemoryType[] {
  const types: MemoryType[] = ["semantic"]
  if (provenance === "user" || provenance === "explicit") types.push("procedural")
  return types
}

export async function runMemoryExtraction(
  input: RunMemoryExtractionInput,
  deps: RunMemoryExtractionDeps
): Promise<{ applied: ConsolidationOp[] }> {
  const empty = { applied: [] as ConsolidationOp[] }
  try {
    const { config } = input
    if (!config.enabled || !config.autoExtract || config.temporary) return empty
    // Connector-inbound content is third-party — never auto-extracted.
    if (input.provenance === "inbound") return empty

    // Salience runs on the RAW text — it's a local heuristic (no model call) and
    // redaction would weaken its named-entity / specificity signals.
    const salience = assessSalience({
      userText: input.newPair.userText,
      assistantText: input.newPair.assistantText,
    })
    if (!salience.salient) return empty

    // Redact before the LLM extract call. PII spans become placeholders; the
    // rest of the turn is intact, so non-PII facts still extract normally.
    const redact = deps.redact ?? ((t: string) => redactText(t).redacted)
    const extractionInput: ExtractMemoriesInput = {
      rollingSummary: input.rollingSummary ? redact(input.rollingSummary) : undefined,
      recentMessages: input.recentMessages?.map((m) => ({ role: m.role, text: redact(m.text) })),
      newPair: {
        userText: redact(input.newPair.userText),
        assistantText: redact(input.newPair.assistantText),
      },
      allowTypes: allowedTypes(input.provenance),
    }
    const isPayloadPiiSafe = deps.isPayloadPiiSafe ?? hasNoLeakingPiiDeep
    if (!isPayloadPiiSafe(extractionInput)) return empty
    const candidates = await deps.extract(extractionInput)
    if (candidates.length === 0) return empty

    const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
    const safe = candidates.filter((c) => isPiiSafe(c.text))
    if (safe.length === 0) return empty

    return await deps.consolidate({
      candidates: safe,
      scope: input.scope,
      characterId: input.characterId,
      projectId: input.projectId,
      agentId: input.agentId,
      branch: input.branch,
      pathPattern: input.pathPattern,
      provenance: input.provenance,
      source: input.source,
    })
  } catch {
    return empty
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Real wiring
// ───────────────────────────────────────────────────────────────────────────

/**
 * Decide a session's provenance for auto-extraction. A session whose binding
 * marks it connector-driven is `inbound` (excluded); a plain local chat is
 * `user`.
 */
export function sessionProvenance(session: ChatSession | null | undefined): MemoryProvenance {
  return session?.platformBinding ? "inbound" : "user"
}

export interface BuildAutoExtractionDepsParams {
  session: ChatSession | null | undefined
  appSettings: AppSettings | null | undefined
}

/**
 * Wire the real extract + consolidate dependencies. Returns `null` when no
 * utility LLM client can be built (e.g. no model configured) — the caller then
 * skips extraction entirely.
 */
export async function buildAutoExtractionDeps(
  params: BuildAutoExtractionDepsParams,
  config: MemoryConfig
): Promise<RunMemoryExtractionDeps | null> {
  const { buildUtilityLlmClient } = await import("@/lib/ai/generation/utility-client")
  const client = buildUtilityLlmClient({
    session: params.session ?? null,
    appSettings: params.appSettings ?? null,
    featureId: "memory-extraction",
  })
  if (!client) return null

  const [{ tryBuildMemoryDeps, tryBuildMemoryVectorSink }, { retrieveMemories }, memDb] =
    await Promise.all([
      import("@/lib/memory/runtime/build-deps"),
      import("@/lib/memory/retrieve/retriever"),
      import("@/lib/db/memories"),
    ])
  const [memDeps, vectorSink] = await Promise.all([
    tryBuildMemoryDeps(config),
    tryBuildMemoryVectorSink(config),
  ])

  const consolidateDeps: ConsolidateDeps = {
    client,
    findSimilar: async (candidate, namespace) => {
      if (!memDeps) return []
      const hits = await retrieveMemories(
        {
          queryText: candidate.text,
          reader: namespace,
          topK: 5,
          relevanceFloor: 0,
          types: [candidate.type],
          // CROSS-CORPUS GUARD, mirroring the project miner's. Without it the
          // judge can be shown a mined project claim and answer UPDATE, folding
          // a fact about the repo into a memory the user stated about
          // themselves — and the row keeps its personal identity, so it goes on
          // rendering under "What you remember about the user".
          claimFilter: "personal-only",
        },
        memDeps
      ).catch(() => [])
      return hits.map((h) => h.memory).filter((memory) => sameMemoryNamespace(memory, namespace))
    },
    persist: async (pInput) => {
      const row = await memDb.createMemory(pInput)
      // Make the new memory semantically searchable when embeddings are
      // configured. Best-effort: a vector failure must not lose the memory.
      if (vectorSink && hasNoLeakingPii(row.text)) {
        try {
          await vectorSink.upsert(row.id, row.text)
          await memDb.updateMemory(row.id, { vectorDocId: row.id })
        } catch {
          // BM25 recall still works without the vector.
        }
      }
      return row
    },
    update: async (id, text) => {
      if (!hasNoLeakingPii(text)) return
      await memDb.updateMemory(id, { text, bumpVersion: true })
      if (vectorSink) {
        try {
          await vectorSink.upsert(id, text)
        } catch {
          // ignore — keep the Dexie update
        }
      }
    },
    invalidate: (id, supersededById) => memDb.invalidateMemory(id, supersededById),
    markConflict: async (targetId, conflictId) => {
      const target = await memDb.getMemory(targetId)
      if (!target) return
      await memDb.updateMemory(targetId, {
        reviewStatus: "conflict",
        conflictWithIds: [...new Set([...(target.conflictWithIds ?? []), conflictId])],
      })
    },
  }

  return {
    extract: (eInput) => extractMemories(eInput, client),
    consolidate: (cInput) => consolidate(cInput, consolidateDeps),
  }
}
