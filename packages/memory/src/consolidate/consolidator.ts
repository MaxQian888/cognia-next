/**
 * LLM-judged consolidation (ADD / UPDATE / DELETE / CONFLICT / NOOP). For each
 * candidate, fetch the top-k semantically similar existing memories and let the
 * LLM choose ONE operation — solving dedupe, update, and contradiction in one
 * place instead of brittle rules.
 *
 * Contradictions never hard-delete: DELETE marks the old memory `invalidated`
 * and links `supersededById` (history preserved — Zep's "update, don't discard").
 * Borrows the cluster-prompt shape from `lib/twin/distill/agents/entity-merge-
 * agent.ts` and the version/ACL discipline from the agent-team shared-memory
 * orchestrator.
 *
 * Dependency-injected + fail-safe: a parse/LLM failure for a candidate defaults
 * to NOOP (never a destructive guess).
 */

import { extractJson, type LlmClient } from "../llm"
import type { Memory, MemoryProvenance, MemoryScope, MemorySourceChannel } from "../types/memory"
import type { MemoryCandidate } from "../extract/extractor"
import { hasNoLeakingPii } from "@cognia/redact"

export interface PersistMemoryInput {
  scope: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  type: MemoryCandidate["type"]
  text: string
  importance: number
  key?: string
  provenance: MemoryProvenance
  sourceSessionId?: string
  sourceMessageId?: string
  sourceChannel?: MemorySourceChannel
  sourcePluginId?: string
  reviewStatus?: Memory["reviewStatus"]
  conflictWithIds?: string[]
  trustState?: Memory["trustState"]
}

export interface ConsolidateDeps {
  client: LlmClient
  /** Top-k active memories similar to the candidate (same scope/reader). */
  findSimilar: (
    candidate: MemoryCandidate,
    namespace: MemoryConsolidationNamespace
  ) => Promise<Memory[]>
  /** ADD — create + persist a new memory; returns the row. */
  persist: (input: PersistMemoryInput) => Promise<Memory>
  /** UPDATE — replace text + bump version. */
  update: (id: string, text: string) => Promise<void>
  /** DELETE — soft-invalidate, optionally linking the superseding memory. */
  invalidate: (id: string, supersededById?: string) => Promise<void>
  /** Mark both sides of an unresolved contradiction for explicit review. */
  markConflict?: (targetId: string, conflictId: string) => Promise<void>
}

export type ConsolidationOp =
  | { op: "ADD"; memory: Memory; candidate: MemoryCandidate }
  | { op: "UPDATE"; targetId: string }
  | { op: "DELETE"; targetId: string }
  | { op: "CONFLICT"; memory: Memory; targetId: string; candidate: MemoryCandidate }
  | {
      /**
       * The judge could not decide anything at all, and the caller asked to fail
       * closed. The row is persisted but stamped `trustState: "quarantined"`, so
       * `isMemoryEligibleForRetrieval` keeps it out of every prompt while the
       * console can still surface it for review.
       */
      op: "QUARANTINE"
      memory: Memory
      candidate: MemoryCandidate
      reason: QuarantineReason
    }
  | { op: "NOOP" }

/** Why a candidate was quarantined rather than merged. */
export type QuarantineReason =
  /** The judge call threw, or its response was not parsable JSON. */
  | "judge_unavailable"
  /** The judge named an operation or a target id that does not exist. */
  | "unresolvable_target"

/**
 * The memory a consolidation op created or mutated, if any.
 *
 * Extracted because four call sites had each copy-pasted this same chain, which
 * meant every new op arm silently defaulted to "no memory to bind" at all four —
 * no evidence row, no audit event, no governance patch. One function makes a new
 * arm a compile-time decision instead of an omission.
 */
export function consolidationOpMemoryId(op: ConsolidationOp): string | undefined {
  switch (op.op) {
    case "ADD":
    case "CONFLICT":
    case "QUARANTINE":
      return op.memory.id
    case "UPDATE":
      return op.targetId
    case "DELETE":
    case "NOOP":
      return undefined
  }
}

export interface ConsolidateInput {
  candidates: MemoryCandidate[]
  scope: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  provenance: MemoryProvenance
  source?: { sessionId?: string; messageId?: string }
  /** API-surface attribution, stamped onto ADDed rows (external provenance). */
  attribution?: { channel: MemorySourceChannel; pluginId?: string }
  /**
   * What to do when the judge cannot produce a usable decision.
   *
   * `"add"` (the default, and the historical behavior) keeps the new fact: for
   * personal memory a lost judge call should not lose something the user said.
   *
   * `"quarantine"` persists the row but stamps it `trustState: "quarantined"`,
   * so it is excluded from retrieval until a human reviews it. Callers whose
   * output is injected into prompts automatically — project mining — must use
   * this: silently ADDing an unjudged claim is how a wrong fact reaches every
   * later turn.
   */
  failureMode?: "add" | "quarantine"
}

export interface MemoryConsolidationNamespace {
  scope: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
}

/** Strict equality prevents a similarity hit from mutating a broader namespace. */
export function sameMemoryNamespace(
  memory: Memory,
  namespace: MemoryConsolidationNamespace
): boolean {
  return (
    memory.scope === namespace.scope &&
    memory.projectId === namespace.projectId &&
    memory.characterId === namespace.characterId &&
    memory.agentId === namespace.agentId &&
    memory.branch === namespace.branch &&
    memory.pathPattern === namespace.pathPattern
  )
}

const DECIDE_SYSTEM =
  "You maintain a long-term memory store. Given a NEW candidate fact and the " +
  "most similar EXISTING memories, choose ONE operation. Return STRICT JSON only."

interface RawDecision {
  op?: unknown
  targetId?: unknown
  mergedText?: unknown
}

function buildDecidePrompt(candidate: MemoryCandidate, similar: Memory[]): string {
  const list = similar.map((m, i) => `${i + 1}. [id=${m.id}] ${m.text}`).join("\n")
  return [
    `Candidate (${candidate.type}): ${candidate.text}`,
    ``,
    `Existing similar memories:`,
    list,
    ``,
    `Decide ONE:`,
    `- ADD: none of the existing memories express this candidate.`,
    `- UPDATE: an existing memory is the SAME fact with new/complementary detail`,
    `  (give its id + "mergedText" combining both).`,
    `- DELETE: the candidate directly CONTRADICTS an existing memory that is now`,
    `  false (give that memory's id; the candidate will be added fresh).`,
    `- CONFLICT: the candidate contradicts an existing memory but the source is`,
    `  not authoritative enough to decide which is true (give that memory's id).`,
    `- NOOP: the candidate is already fully captured.`,
    `Return JSON: {"op":"ADD|UPDATE|DELETE|CONFLICT|NOOP","targetId?":"<id>","mergedText?":"<text>"}.`,
  ].join("\n")
}

async function persistCandidate(
  candidate: MemoryCandidate,
  input: ConsolidateInput,
  deps: ConsolidateDeps,
  governance: Pick<PersistMemoryInput, "reviewStatus" | "conflictWithIds" | "trustState"> = {}
): Promise<Memory> {
  return deps.persist({
    scope: input.scope,
    characterId: input.scope === "character" ? input.characterId : undefined,
    projectId: input.projectId,
    agentId: input.scope === "agent" ? input.agentId : undefined,
    branch: input.branch,
    pathPattern: input.pathPattern,
    type: candidate.type,
    text: candidate.text,
    importance: candidate.importance,
    key: candidate.key,
    provenance: input.provenance,
    sourceSessionId: input.source?.sessionId,
    sourceMessageId: input.source?.messageId,
    sourceChannel: input.attribution?.channel,
    sourcePluginId: input.attribution?.pluginId,
    ...governance,
  })
}

/**
 * Audit action describing what a consolidation op did to its memory.
 *
 * Shared for the same reason as `consolidationOpMemoryId`: three call sites had
 * copy-pasted a ternary whose fall-through was `"revised"`, so a newly added
 * creating arm would have been recorded as an edit to a row that had just been
 * created.
 */
export function consolidationAuditAction(
  op: ConsolidationOp
): "created" | "revised" | "conflict" | undefined {
  switch (op.op) {
    case "CONFLICT":
      return "conflict"
    case "ADD":
    case "QUARANTINE":
      return "created"
    case "UPDATE":
      return "revised"
    case "DELETE":
    case "NOOP":
      return undefined
  }
}

/**
 * Apply the caller's failure mode when the judge produced nothing usable.
 *
 * Both modes PERSIST. Dropping the candidate would lose the fact silently and
 * leave the user no signal that anything was mined at all; quarantining keeps it
 * out of prompts (`isMemoryEligibleForRetrieval` excludes `"quarantined"`) while
 * leaving it reviewable in the console.
 */
async function failClosed(
  candidate: MemoryCandidate,
  input: ConsolidateInput,
  deps: ConsolidateDeps,
  reason: QuarantineReason
): Promise<ConsolidationOp> {
  if (input.failureMode !== "quarantine") {
    const memory = await persistCandidate(candidate, input, deps)
    return { op: "ADD", memory, candidate }
  }
  const memory = await persistCandidate(candidate, input, deps, {
    reviewStatus: "unreviewed",
    trustState: "quarantined",
  })
  return { op: "QUARANTINE", memory, candidate, reason }
}

export async function consolidate(
  input: ConsolidateInput,
  deps: ConsolidateDeps
): Promise<{ applied: ConsolidationOp[] }> {
  const applied: ConsolidationOp[] = []

  for (const candidate of input.candidates) {
    if (!candidate.text.trim() || !hasNoLeakingPii(candidate.text)) continue
    const namespace: MemoryConsolidationNamespace = {
      scope: input.scope,
      characterId: input.scope === "character" ? input.characterId : undefined,
      projectId: input.projectId,
      agentId: input.scope === "agent" ? input.agentId : undefined,
      branch: input.branch,
      pathPattern: input.pathPattern,
    }
    const similar = (await deps.findSimilar(candidate, namespace).catch(() => [])).filter(
      (memory) => hasNoLeakingPii(memory.text)
    )

    // No neighbors → unambiguous ADD, no LLM call needed.
    if (similar.length === 0) {
      const memory = await persistCandidate(candidate, input, deps)
      applied.push({ op: "ADD", memory, candidate })
      continue
    }

    let decision: RawDecision
    try {
      const raw = await deps.client.complete(buildDecidePrompt(candidate, similar), {
        system: DECIDE_SYSTEM,
        temperature: 0,
        maxTokens: 256,
      })
      decision = extractJson<RawDecision>(raw)
    } catch {
      applied.push(await failClosed(candidate, input, deps, "judge_unavailable"))
      continue
    }

    const op = typeof decision.op === "string" ? decision.op.toUpperCase() : "NOOP"
    const targetId =
      typeof decision.targetId === "string" && similar.some((m) => m.id === decision.targetId)
        ? decision.targetId
        : undefined

    if (op === "UPDATE" && targetId) {
      const mergedText =
        typeof decision.mergedText === "string" && decision.mergedText.trim()
          ? hasNoLeakingPii(decision.mergedText.trim())
            ? decision.mergedText.trim()
            : candidate.text
          : candidate.text
      await deps.update(targetId, mergedText)
      applied.push({ op: "UPDATE", targetId })
    } else if (op === "DELETE" && targetId) {
      const memory = await persistCandidate(candidate, input, deps)
      await deps.invalidate(targetId, memory.id)
      applied.push({ op: "DELETE", targetId })
      applied.push({ op: "ADD", memory, candidate })
    } else if (op === "CONFLICT" && targetId) {
      const memory = await persistCandidate(candidate, input, deps, {
        reviewStatus: "conflict",
        conflictWithIds: [targetId],
      })
      await deps.markConflict?.(targetId, memory.id)
      applied.push({ op: "CONFLICT", memory, targetId, candidate })
    } else if (op === "NOOP") {
      applied.push({ op: "NOOP" })
    } else if (op === "ADD") {
      const memory = await persistCandidate(candidate, input, deps)
      applied.push({ op: "ADD", memory, candidate })
    } else {
      // An UPDATE/DELETE/CONFLICT whose targetId was missing or hallucinated
      // (not in the candidate set), or an operation name we do not recognise.
      // The judge decided nothing usable, so this takes the configured failure
      // mode — never a silent drop, which would lose a genuinely new fact.
      applied.push(await failClosed(candidate, input, deps, "unresolvable_target"))
    }
  }

  return { applied }
}
