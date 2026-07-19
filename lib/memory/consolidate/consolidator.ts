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

import { extractJson, type LlmClient } from "@/lib/twin/distill/llm"
import type {
  Memory,
  MemoryProvenance,
  MemoryScope,
  MemorySourceChannel,
} from "@/types/memory/memory"
import type { MemoryCandidate } from "@/lib/memory/extract/extractor"
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
  | { op: "NOOP" }

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
  governance: Pick<PersistMemoryInput, "reviewStatus" | "conflictWithIds"> = {}
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
      // Safe default: keep the new fact (ADD) rather than risk losing it or
      // mutating the wrong row.
      const memory = await persistCandidate(candidate, input, deps)
      applied.push({ op: "ADD", memory, candidate })
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
    } else {
      // ADD, or an UPDATE/DELETE whose targetId was missing/hallucinated (not in
      // the candidate set). Keep the new fact rather than silently dropping it —
      // the same safe default as the parse-failure path above. Falling through
      // to NOOP here would lose a genuinely new memory whenever the model named
      // a non-existent id.
      const memory = await persistCandidate(candidate, input, deps)
      applied.push({ op: "ADD", memory, candidate })
    }
  }

  return { applied }
}
