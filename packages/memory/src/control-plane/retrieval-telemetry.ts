/**
 * The control-plane artifacts a memory recall produces.
 *
 * Memory keeps its own ranking pipeline: the kernel in `@cognia/rag` owns
 * fusion, eligibility, content resolution and budgeting, and adopting it would
 * mean rewriting how memories are scored. What Memory adopts instead is the
 * kernel's VOCABULARY, so a degraded recall is describable in the same terms as
 * every other retrieval domain and its trace lands in the same table.
 *
 * The point of all this is one specific lie the retriever used to tell: a
 * vector leg that threw was caught, emptied, and reported as a perfectly normal
 * BM25 result. "The vector backend is down" and "the corpus has nothing" were
 * indistinguishable from outside.
 */

import {
  isDegradingRetrievalReason,
  type RetrievalDegradeCode,
  type RetrievalDegradeReason,
  type RetrievalTraceV1,
} from "@cognia/rag/retrieval-kernel"

import type { RetrievedMemory } from "../retrieve/retriever"

export type { RetrievalDegradeCode, RetrievalDegradeReason, RetrievalTraceV1 }

export interface MemoryRetrievalOutcome {
  hits: RetrievedMemory[]
  /** True when the answer is worse than the corpus allows. */
  degraded: boolean
  /** Finite by construction: every code is one the shared kernel declares. */
  reasons: RetrievalDegradeReason[]
  trace: RetrievalTraceV1
}

/**
 * Why the vector leg was never wired for a call, in the CONFIGURATION
 * vocabulary that `describeMemoryRetrievalMode` owns and the settings chip
 * renders. Mirrored here so this module stays free of app imports.
 */
export type MemoryRetrievalConfigReason =
  "hybrid_disabled" | "no_backend" | "store_unsupported" | "cloud_blocked"

/**
 * Collapse the four configuration reasons onto the one recall code.
 *
 * All four mean the same thing to a trace: the vector leg did not run. Nothing
 * is lost, because the four-way "why" stays in `MemoryRetrievalMode`, which is
 * what the chip and the settings panel read.
 *
 * `cloud_blocked` deliberately maps to `vector_not_configured` and NOT to
 * `embedding_unavailable`. A user who never opted into cloud embedding did not
 * suffer a failure, and recording one would make the health signal cry wolf.
 */
const CONFIG_REASON_CODES: Record<MemoryRetrievalConfigReason, RetrievalDegradeCode> = {
  hybrid_disabled: "vector_not_configured",
  no_backend: "vector_not_configured",
  store_unsupported: "vector_not_configured",
  cloud_blocked: "vector_not_configured",
}

export function toRetrievalDegradeCode(reason: MemoryRetrievalConfigReason): RetrievalDegradeCode {
  return CONFIG_REASON_CODES[reason]
}

/**
 * Whether a reason should light the "degraded" badge on an assistant message.
 *
 * Narrower than the kernel's predicate on purpose. `allowCloudEmbedding`
 * defaults to false, so most profiles run BM25-only by configuration, and
 * treating that as degraded would pin the badge on permanently for the
 * majority of users. A recall that never had a vector leg is not degraded; a
 * recall whose vector leg broke, or was stopped by the kill switch, is.
 */
export function isMemoryRuntimeDegrade(code: RetrievalDegradeCode): boolean {
  return isDegradingRetrievalReason(code) && code !== "vector_not_configured"
}

export function memoryRuntimeDegraded(reasons: readonly RetrievalDegradeReason[]): boolean {
  return reasons.some((reason) => isMemoryRuntimeDegrade(reason.code))
}

export function memoryRetrievalDegraded(reasons: readonly RetrievalDegradeReason[]): boolean {
  return reasons.some((reason) => isDegradingRetrievalReason(reason.code))
}

/** Which corpus a recall read, so personal and project traces never merge. */
export function memoryCorpusId(input: {
  claimFilter?: "personal-only" | "project-only"
  projectId?: string
}): string {
  if (input.claimFilter === "personal-only") return "memory:personal"
  if (input.claimFilter === "project-only") {
    return `memory:project:${input.projectId ?? "unknown"}`
  }
  // Everything that reads BOTH corpora: MCP and plugin search, the workflow
  // node, the pet, the console, and the extraction dedupe lookups.
  return "memory:search"
}
