/**
 * `action.memory.recall` — query the autonomous long-term memory store
 * (lib/memory) from a workflow. Read-only: BM25 + (when configured and
 * privacy-permitted) vector hybrid retrieval with the same 3-factor scoring
 * the chat injection path uses.
 *
 * Best-effort contract: a disabled memory system or missing backend never
 * fails the step — it returns `{ entries: [], degraded: true }` with a
 * warning log, mirroring how chat degrades.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import type { MemoryScope, MemoryType } from "@/types/memory/memory"

export interface MemoryRecallParams {
  query?: string
  topK?: number
  scope?: MemoryScope
  /** Required when scope === "character". */
  characterId?: string
  /** Required when scope === "workspace". */
  projectId?: string
  /** Required when scope === "agent". */
  agentId?: string
  branch?: string
  path?: string
  /** Drop hits whose normalized relevance is below this (0..1). */
  relevanceFloor?: number
  /** Restrict to memory types (semantic / episodic / procedural). */
  types?: MemoryType[]
}

export async function runMemoryRecall(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as MemoryRecallParams
  const query = (params.query ?? "").trim()
  if (!query) throw nonRetryable("action.memory.recall requires a non-empty 'query'")
  const scope = params.scope ?? "global"
  if (scope === "character" && !params.characterId) {
    throw nonRetryable("action.memory.recall: 'characterId' is required when scope is 'character'")
  }
  if (scope === "workspace" && !params.projectId) {
    throw nonRetryable("action.memory.recall: 'projectId' is required when scope is 'workspace'")
  }
  if (scope === "agent" && !params.agentId) {
    throw nonRetryable("action.memory.recall: 'agentId' is required when scope is 'agent'")
  }

  const [{ authorizeMemoryRead, narrowReaderToCaller }, { workflowCaller }] = await Promise.all([
    import("@/lib/memory/api/read-memory"),
    import("@/lib/memory/api/caller"),
  ])
  // The run's trigger binding supplies the governing persona/session — the
  // node's `characterId`/`agentId` params only narrow the namespace read.
  const binding = ctx.trigger.binding
  const caller = {
    ...workflowCaller(ctx.runId),
    ...(binding?.sessionId ? { sessionId: binding.sessionId } : {}),
    ...(binding?.characterId ? { policyCharacterId: binding.characterId } : {}),
  }
  const authorized = await authorizeMemoryRead(caller)
  if (!authorized.ok) {
    // Disabled / temporary / policy-denied all degrade to an empty read — a
    // workflow run must not fail just because memory is unavailable.
    ctx.log(
      "warn",
      `action.memory.recall: memory read denied (${authorized.reason}) — returning no entries.`
    )
    return { output: { entries: [], degraded: true, reason: authorized.reason } }
  }
  const { config, read } = authorized
  const reader = narrowReaderToCaller(
    {
      characterId: scope === "character" ? params.characterId : undefined,
      projectId: params.projectId,
      agentId: scope === "agent" ? params.agentId : undefined,
      branch: params.branch,
      path: params.path,
    },
    caller
  )
  if (!reader) {
    ctx.log(
      "warn",
      "action.memory.recall: requested namespace outside the run's authorization — returning no entries."
    )
    return { output: { entries: [], degraded: true, reason: "unauthorized_namespace" } }
  }

  const { tryBuildMemoryDeps } = await import("@/lib/memory/runtime/build-deps")
  const baseDeps = await tryBuildMemoryDeps(config)
  if (!baseDeps) {
    ctx.log("warn", "action.memory.recall: memory backend unavailable — returning no entries.")
    return { output: { entries: [], degraded: true, reason: "backend_unavailable" } }
  }
  // Candidates are authorized before scoring; hits are re-checked after, the
  // same defense-in-depth the external search surface applies. (Procedural
  // lines are not part of recall — the retriever only reads `loadCandidates`.)
  const deps = {
    ...baseDeps,
    loadCandidates: async (candidateReader: Parameters<typeof baseDeps.loadCandidates>[0]) =>
      (await baseDeps.loadCandidates(candidateReader)).filter((memory) =>
        read.isAuthorized(memory)
      ),
  }

  const { retrieveMemories } = await import("@/lib/memory/retrieve/retriever")
  const hits = await retrieveMemories(
    {
      queryText: query,
      reader,
      topK: params.topK ?? 6,
      relevanceFloor: params.relevanceFloor ?? 0.1,
      types: params.types,
      recencyHalfLifeDays: config.decayHalfLifeDays,
    },
    deps
  )

  return {
    output: {
      entries: hits
        .filter((h) => read.isAuthorized(h.memory))
        .map((h) => ({
          id: h.memory.id,
          text: h.memory.text,
          type: h.memory.type,
          scope: h.memory.scope,
          importance: h.memory.importance,
          relevance: h.relevance,
          score: h.score,
        })),
      degraded: false,
    },
  }
}

function nonRetryable(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { retryable: boolean }).retryable = false
  return err
}
