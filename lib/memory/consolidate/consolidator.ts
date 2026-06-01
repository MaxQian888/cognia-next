/**
 * LLM-judged consolidation (Mem0's ADD / UPDATE / DELETE / NOOP). For each
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
import type { Memory, MemoryProvenance, MemoryScope } from "@/types/memory/memory"
import type { MemoryCandidate } from "@/lib/memory/extract/extractor"

export interface PersistMemoryInput {
  scope: MemoryScope
  characterId?: string
  type: MemoryCandidate["type"]
  text: string
  importance: number
  key?: string
  provenance: MemoryProvenance
  sourceSessionId?: string
  sourceMessageId?: string
}

export interface ConsolidateDeps {
  client: LlmClient
  /** Top-k active memories similar to the candidate (same scope/reader). */
  findSimilar: (
    candidate: MemoryCandidate,
    scope: MemoryScope,
    characterId?: string
  ) => Promise<Memory[]>
  /** ADD — create + persist a new memory; returns the row. */
  persist: (input: PersistMemoryInput) => Promise<Memory>
  /** UPDATE — replace text + bump version. */
  update: (id: string, text: string) => Promise<void>
  /** DELETE — soft-invalidate, optionally linking the superseding memory. */
  invalidate: (id: string, supersededById?: string) => Promise<void>
}

export type ConsolidationOp =
  | { op: "ADD"; memory: Memory; candidate: MemoryCandidate }
  | { op: "UPDATE"; targetId: string }
  | { op: "DELETE"; targetId: string }
  | { op: "NOOP" }

export interface ConsolidateInput {
  candidates: MemoryCandidate[]
  scope: MemoryScope
  characterId?: string
  provenance: MemoryProvenance
  source?: { sessionId?: string; messageId?: string }
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
    `- NOOP: the candidate is already fully captured.`,
    `Return JSON: {"op":"ADD|UPDATE|DELETE|NOOP","targetId?":"<id>","mergedText?":"<text>"}.`,
  ].join("\n")
}

async function persistCandidate(
  candidate: MemoryCandidate,
  input: ConsolidateInput,
  deps: ConsolidateDeps
): Promise<Memory> {
  return deps.persist({
    scope: input.scope,
    characterId: input.scope === "character" ? input.characterId : undefined,
    type: candidate.type,
    text: candidate.text,
    importance: candidate.importance,
    key: candidate.key,
    provenance: input.provenance,
    sourceSessionId: input.source?.sessionId,
    sourceMessageId: input.source?.messageId,
  })
}

export async function consolidate(
  input: ConsolidateInput,
  deps: ConsolidateDeps
): Promise<{ applied: ConsolidationOp[] }> {
  const applied: ConsolidationOp[] = []

  for (const candidate of input.candidates) {
    if (!candidate.text.trim()) continue
    const similar = await deps
      .findSimilar(candidate, input.scope, input.characterId)
      .catch(() => [])

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
          ? decision.mergedText.trim()
          : candidate.text
      await deps.update(targetId, mergedText)
      applied.push({ op: "UPDATE", targetId })
    } else if (op === "DELETE" && targetId) {
      const memory = await persistCandidate(candidate, input, deps)
      await deps.invalidate(targetId, memory.id)
      applied.push({ op: "DELETE", targetId })
      applied.push({ op: "ADD", memory, candidate })
    } else if (op === "ADD") {
      const memory = await persistCandidate(candidate, input, deps)
      applied.push({ op: "ADD", memory, candidate })
    } else {
      applied.push({ op: "NOOP" })
    }
  }

  return { applied }
}
