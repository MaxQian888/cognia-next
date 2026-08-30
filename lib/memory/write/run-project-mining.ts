/**
 * Project-context mining orchestrator — the write path that learns about the
 * WORKSPACE rather than about the user.
 *
 * Mirrors `run-memory-extraction.ts` deliberately: a dependency-injected pure
 * core (`runProjectMining`) plus a `build*Deps` wiring function. Same shape,
 * different corpus, so the two paths stay comparable when either is changed.
 *
 * Pipeline (each gate short-circuits with a named reason, so a session that
 * mines nothing can be explained instead of merely being silent):
 *
 *   config gates → path normalization → salience → redact → payload PII gate
 *   → extract (LLM) → per-claim PII gate → consolidate(failureMode:"quarantine")
 *
 * PATH NORMALIZATION RUNS FIRST, before redaction. Project mining is the only
 * write path that feeds TOOL RESULT bodies to a model, and those are saturated
 * with absolute paths carrying the OS username. `hasNoLeakingPii` has no
 * home-directory rule, so without this step the username would reach both Dexie
 * and the shared vector collection. It runs before `redactText` so the
 * placeholders that redaction emits are never re-parsed as path segments.
 *
 * CONSOLIDATION FAILS CLOSED. Unlike personal extraction, whose fallback is to
 * keep what the user said, an unjudged mined claim is quarantined: it is a
 * guess about the project that would otherwise be injected into every later turn.
 */

import type { ChatSession, AppSettings } from "@cognia/agent-config-types"
import type { MemoryConfig, MemoryProvenance, MemoryScope } from "@/types/memory/memory"
import {
  assessProjectSalience,
  type ProjectSalienceSignal,
} from "@cognia/memory/extract/project-salience"
import { normalizeProjectPaths } from "@cognia/memory/extract/project-path-normalize"
import {
  extractProjectClaims,
  PROJECT_PROMPT_VERSION,
  type ExtractProjectClaimsInput,
  type ProjectClaimCandidate,
} from "@cognia/memory/extract/project-extractor"
import type { ProjectWindowMessage } from "@cognia/memory/extract/project-windows"
import {
  consolidate,
  sameMemoryNamespace,
  type ConsolidateDeps,
  type ConsolidateInput,
  type ConsolidationCandidate,
  type ConsolidationOp,
} from "@/lib/memory/consolidate/consolidator"
import { hashContent } from "@/lib/project-knowledge/ingest/ingest-file"
import { hasNoLeakingPii, hasNoLeakingPiiDeep, redactText } from "@cognia/redact"

/** Why a window produced nothing. Surfaced as the job's `resultCode`. */
export type ProjectMiningSkipReason =
  | "mining_disabled"
  | "temporary_session"
  | "project_missing"
  | "window_empty"
  | "identifying_path"
  | "not_salient"
  | "payload_pii_blocked"
  | "no_candidates"
  | "no_safe_candidates"

export interface RunProjectMiningInput {
  /** One mining window. Text is RAW — this function owns normalization + redaction. */
  messages: readonly ProjectWindowMessage[]
  /** The workspace these claims belong to. Mining without one is meaningless. */
  projectId: string
  /** Absolute project roots, used to rewrite in-root paths to workspace-relative. */
  workspaceRoots?: readonly string[]
  /** Short workspace description, for disambiguation in the prompt. */
  projectHint?: string
  scope: MemoryScope
  characterId?: string
  agentId?: string
  branch?: string
  provenance: MemoryProvenance
  source?: { sessionId?: string }
  /** `ChatSession.transcriptRevision` at mining time. */
  transcriptRevision?: number
  config: MemoryConfig
}

export interface RunProjectMiningDeps {
  extract: (input: ExtractProjectClaimsInput) => Promise<ProjectClaimCandidate[]>
  consolidate: (input: ConsolidateInput) => Promise<{ applied: ConsolidationOp[] }>
  /** Per-claim PII gate; defaults to `hasNoLeakingPii`. */
  isPiiSafe?: (text: string) => boolean
  /** Fail-closed gate over the whole redacted payload sent to the utility LLM. */
  isPayloadPiiSafe?: (value: unknown) => boolean
  /** Defaults to the twin redactor. */
  redact?: (text: string) => string
  /** Stamped onto `Memory.extractor` so a bad prompt's output can be found in bulk. */
  extractorIdentity?: { provider: string; model: string }
}

export interface RunProjectMiningResult {
  applied: ConsolidationOp[]
  /** Set when `applied` is empty and the window was skipped for a known reason. */
  skipReason?: ProjectMiningSkipReason
  /** Which salience signals fired, for the console's "why was this mined". */
  signals?: ProjectSalienceSignal[]
  /**
   * messageId → the normalized-and-redacted excerpt actually sent to the model.
   *
   * The caller hashes these into `MemoryEvidence.excerptHash`. Returning them
   * rather than letting the caller re-derive them is what makes the
   * `message-presence` re-check meaningful: the stored hash is of the exact text
   * this run reasoned over, so a later mismatch really does mean the source
   * changed, not that the two sides normalized differently.
   */
  redactedExcerpts?: ReadonlyMap<string, string>
}

/**
 * Hash of the ordered evidence set.
 *
 * Reuses `hashContent` (the same synchronous djb2 the knowledge ingester uses)
 * rather than adding a second hash: the re-check sweep only needs "did the
 * support set change", and a crypto digest would make this async on a path that
 * has no other reason to be.
 */
export function projectClaimEvidenceHash(claim: ProjectClaimCandidate): string {
  return hashContent(claim.evidence.map((item) => `${item.kind}:${item.sourceId}`).join("|"))
}

function skipped(reason: ProjectMiningSkipReason): RunProjectMiningResult {
  return { applied: [], skipReason: reason }
}

export async function runProjectMining(
  input: RunProjectMiningInput,
  deps: RunProjectMiningDeps
): Promise<RunProjectMiningResult> {
  try {
    const { config } = input
    // `learnFromChats` is the user's one switch for "may this conversation
    // teach Cognia anything"; `mineProjectContext` narrows it to this corpus.
    if (!config.enabled || !config.learnFromChats || !config.mineProjectContext) {
      return skipped("mining_disabled")
    }
    if (config.temporary) return skipped("temporary_session")
    if (!input.projectId) return skipped("project_missing")

    const usable = input.messages.filter((message) => message.id && message.text.trim())
    if (usable.length === 0) return skipped("window_empty")

    // Step 0 — path normalization. A single message that still carries an
    // identifying path fails the WHOLE window: a claim mined from text we had to
    // censor mid-sentence no longer says what the transcript said.
    const roots = input.workspaceRoots ?? []
    const normalized: ProjectWindowMessage[] = []
    for (const message of usable) {
      const result = normalizeProjectPaths(message.text, { roots })
      if (!result.ok) return skipped("identifying_path")
      normalized.push({ ...message, text: result.text })
    }

    // Salience runs on normalized-but-unredacted text: it is a local heuristic
    // and redaction would blunt exactly the path and identifier signals it reads.
    const salience = assessProjectSalience({ messages: normalized })
    if (!salience.salient)
      return { applied: [], skipReason: "not_salient", signals: salience.signals }

    const redact = deps.redact ?? ((text: string) => redactText(text).redacted)
    const extractionInput: ExtractProjectClaimsInput = {
      messages: normalized.map((message) => ({
        id: message.id,
        role: message.role,
        text: redact(message.text),
      })),
      ...(input.projectHint ? { projectHint: input.projectHint } : {}),
    }
    const redactedExcerpts = new Map(
      extractionInput.messages.map((message) => [message.id, message.text])
    )
    const isPayloadPiiSafe = deps.isPayloadPiiSafe ?? hasNoLeakingPiiDeep
    if (!isPayloadPiiSafe(extractionInput)) return skipped("payload_pii_blocked")

    const claims = await deps.extract(extractionInput)
    if (claims.length === 0)
      return { applied: [], skipReason: "no_candidates", signals: salience.signals }

    const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
    const safe = claims.filter((claim) => isPiiSafe(claim.text))
    if (safe.length === 0) {
      return { applied: [], skipReason: "no_safe_candidates", signals: salience.signals }
    }

    const observedAtById = new Map(usable.map((message) => [message.id, message.createdAt]))
    const candidates: ConsolidationCandidate[] = safe.map((claim) => ({
      // Project claims are semantic by construction. `type` answers "what kind
      // of memory" (the LangMem axis); `projectMemoryKind` answers "about what".
      type: "semantic",
      text: claim.text,
      importance: claim.importance,
      ...(claim.key ? { key: claim.key } : {}),
      projectClaim: {
        projectMemoryKind: claim.kind,
        observedAtMessageId: claim.observedAtMessageId,
        ...(observedAtById.get(claim.observedAtMessageId) !== undefined
          ? { observedAt: observedAtById.get(claim.observedAtMessageId) }
          : {}),
        confidence: claim.confidence,
        ...(claim.scopeRationale ? { scopeRationale: claim.scopeRationale } : {}),
        ...(deps.extractorIdentity
          ? {
              extractor: {
                provider: deps.extractorIdentity.provider,
                model: deps.extractorIdentity.model,
                promptVersion: PROJECT_PROMPT_VERSION,
              },
            }
          : {}),
        evidenceHash: projectClaimEvidenceHash(claim),
        ...(input.transcriptRevision !== undefined
          ? { sourceRevision: String(input.transcriptRevision) }
          : {}),
        evidence: claim.evidence,
      },
    }))

    const result = await deps.consolidate({
      candidates,
      scope: input.scope,
      characterId: input.characterId,
      projectId: input.projectId,
      agentId: input.agentId,
      branch: input.branch,
      provenance: input.provenance,
      source: input.source,
      // A claim the judge could not place is persisted but quarantined, never
      // silently ADDed — see the module header.
      failureMode: "quarantine",
    })
    return { applied: result.applied, signals: salience.signals, redactedExcerpts }
  } catch {
    // Mining must never break a send, and never throws into the job worker's
    // retry budget for a reason that will not change on the next attempt.
    return { applied: [] }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Real wiring
// ───────────────────────────────────────────────────────────────────────────

export interface BuildProjectMiningDepsParams {
  session: ChatSession | null | undefined
  appSettings: AppSettings | null | undefined
}

/**
 * Wire the real extract + consolidate dependencies. Returns `null` when no
 * utility LLM client can be built, exactly like `buildAutoExtractionDeps`.
 */
export async function buildProjectMiningDeps(
  params: BuildProjectMiningDepsParams,
  config: MemoryConfig
): Promise<RunProjectMiningDeps | null> {
  // The configured Agent's utility model first, then one headless turn.
  //
  // Mining MUST reach a model on a plain subscription install, which
  // `buildUtilityLlmClient` alone cannot do — it needs a renderer-visible API
  // key, and a subscription's bearer never leaves the host (ADR-0025). Without
  // the fallback this whole feature would be default-on and permanently inert
  // for most users, reporting `dependencies_unavailable` forever.
  //
  // The cost shape is deliberate and is why the enqueue side queues windows
  // rather than turns: one turn per closed ~12-message window that cleared the
  // salience gate, not one per send.
  const { buildAgentBackedLlmClient } = await import("@/lib/ai/generation/agent-backed-client")
  const client = await buildAgentBackedLlmClient({
    role: "utility",
    session: params.session ?? null,
    appSettings: params.appSettings ?? null,
    featureId: "memory-project-mining",
    label: "Project context mining",
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
          // CROSS-CORPUS GUARD. Without it the judge can be shown a personal
          // memory and answer UPDATE, rewriting a fact the user stated about
          // themselves with a fact mined about their repo — and the rewritten
          // row keeps its personal identity, so it goes on rendering under
          // "What you remember about the user". This is the write-side twin of
          // the retriever's `claimFilter` partition.
          claimFilter: "project-only",
        },
        memDeps
      ).catch(() => [])
      return hits
        .map((hit) => hit.memory)
        .filter((memory) => sameMemoryNamespace(memory, namespace))
    },
    persist: async (pInput) => {
      const row = await memDb.createMemory(pInput)
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
    extract: (eInput) => extractProjectClaims(eInput, client),
    consolidate: (cInput) => consolidate(cInput, consolidateDeps),
    // Only stamped when the client actually reports what it resolved to. A
    // fabricated `"unknown"` would be worse than an absent `extractor`: the
    // bulk re-mine query would match rows it cannot actually re-derive.
    ...(client.provider && client.model
      ? { extractorIdentity: { provider: client.provider, model: client.model } }
      : {}),
  }
}
