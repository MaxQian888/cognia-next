// Strategy planner for the generic-path compactor.
//
// Pure decomposition of "what to compact and how" for each CompressionStrategy
// (types/system/compression.ts). The LLM round-trips + final assembly stay in
// `ai-sdk.mjs maybeCompact` (it owns `protocolAdapter.start`). `planStrategy`
// returns a structured plan; the orchestrator runs 0/1/N summary calls per kind.
//
// Plan kinds:
//   none      — nothing old enough to compact.
//   rebuild   — no LLM; `rebuilt` is the final conversation (sliding-window, or a
//               selective/summary fallback when there is nothing to summarize).
//   single    — summarize `middle` into ONE summary (summary + hybrid).
//   selective — keep important `keep` verbatim, summarize `summarizeSet`.
//   chunked   — summarize each of `chunks` (recursive), then combine.
// Common assembly pieces (systemHead, frozen, keep, tail) are reused by the
// orchestrator as `[...systemHead, ...frozen, ...keep, <summary>, ...tail]`.

import { planCompaction, estimateTokens, getContextWindow } from "./compaction.mjs"
import { scoreMessage as defaultScoreMessage } from "./importance.mjs"

/** Floor on the verbatim tail — the drain-line never evicts below this. */
export const MIN_TAIL = 2

/** Drain-line fraction "hybrid" defaults to when the caller sets none — this is
 * what makes hybrid ("sliding window for recent + summary for older") a
 * distinct strategy instead of silently degrading to plain "summary". */
export const HYBRID_DEFAULT_RETAINED_FRACTION = 0.5

export function planStrategy({
  strategy = "summary",
  conversation,
  keepRecent = 6,
  preserveSystemMessages = false,
  recursiveChunkSize = 20,
  importanceThreshold = 0.4,
  retainedFraction,
  contextWindow,
  modelId,
  scoreMessage = defaultScoreMessage,
}) {
  const base = planCompaction({ conversation, keepRecentMessages: keepRecent })
  if (!base) return { kind: "none" }
  const { systemHead, frozen } = base
  const middle = [...base.middle]
  const tail = [...base.tail]

  // Hybrid = summary of the old middle PLUS an always-active sliding-window
  // drain of the tail. Without a caller-set fraction the drain still engages
  // at a sane default; the other strategies keep drain opt-in.
  const effectiveRetained =
    strategy === "hybrid" && typeof retainedFraction !== "number"
      ? HYBRID_DEFAULT_RETAINED_FRACTION
      : retainedFraction

  // Drain-line: evict the oldest tail messages into the summarize region until
  // the RETAINED content (head + frozen + tail; the new summary is bounded
  // separately) fits under retainedFraction*window. Floors at MIN_TAIL.
  if (typeof effectiveRetained === "number" && effectiveRetained > 0 && effectiveRetained < 1) {
    // Prefer the caller's authoritative (catalog-resolved) window — the regex
    // table in `getContextWindow` drifts and floors unknown models at 128k,
    // which over-evicts the tail on large-window models.
    const windowTokens =
      typeof contextWindow === "number" && contextWindow > 0
        ? contextWindow
        : getContextWindow(modelId)
    const budget = effectiveRetained * windowTokens
    // Incremental accounting: the head+frozen cost is fixed; each eviction only
    // removes one message's tokens, so re-scanning the whole retained set per
    // iteration (O(n²)) is unnecessary.
    const fixedCost = estimateTokens([...systemHead, ...frozen])
    let tailCost = estimateTokens(tail)
    while (tail.length > MIN_TAIL && fixedCost + tailCost > budget) {
      const evicted = tail.shift()
      tailCost -= estimateTokens([evicted])
      middle.push(evicted)
    }
  }

  const protectedSystems = () =>
    preserveSystemMessages ? middle.filter((m) => m.role === "system") : []

  if (strategy === "sliding-window") {
    // No LLM: drop the summarizable middle, keep recent + protected systems.
    return { kind: "rebuild", rebuilt: [...systemHead, ...frozen, ...protectedSystems(), ...tail] }
  }

  if (strategy === "selective") {
    const total = conversation.length
    const keep = []
    const summarizeSet = []
    middle.forEach((m, idx) => {
      if (preserveSystemMessages && m.role === "system") {
        keep.push(m)
        return
      }
      const globalIndex = systemHead.length + frozen.length + idx
      const { score } = scoreMessage(m, { index: globalIndex, total })
      if (score >= importanceThreshold) keep.push(m)
      else summarizeSet.push(m)
    })
    if (summarizeSet.length === 0) {
      return { kind: "rebuild", rebuilt: [...systemHead, ...frozen, ...keep, ...tail] }
    }
    return { kind: "selective", systemHead, frozen, keep, summarizeSet, tail }
  }

  if (strategy === "recursive") {
    const keep = protectedSystems()
    const summarizable = preserveSystemMessages ? middle.filter((m) => m.role !== "system") : middle
    const size = Math.max(1, recursiveChunkSize)
    const chunks = []
    for (let i = 0; i < summarizable.length; i += size) chunks.push(summarizable.slice(i, i + size))
    if (chunks.length === 0) {
      return { kind: "rebuild", rebuilt: [...systemHead, ...frozen, ...keep, ...tail] }
    }
    return { kind: "chunked", systemHead, frozen, keep, chunks, tail }
  }

  // "summary" | "hybrid" → a single summary of the middle.
  const keep = protectedSystems()
  const summarizeSet = preserveSystemMessages ? middle.filter((m) => m.role !== "system") : middle
  if (summarizeSet.length === 0) {
    return { kind: "rebuild", rebuilt: [...systemHead, ...frozen, ...keep, ...tail] }
  }
  return { kind: "single", systemHead, frozen, keep, middle: summarizeSet, tail }
}
