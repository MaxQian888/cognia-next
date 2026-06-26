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

export function planStrategy({
  strategy = "summary",
  conversation,
  keepRecent = 6,
  preserveSystemMessages = false,
  recursiveChunkSize = 20,
  importanceThreshold = 0.4,
  retainedFraction,
  modelId,
  scoreMessage = defaultScoreMessage,
}) {
  const base = planCompaction({ conversation, keepRecentMessages: keepRecent })
  if (!base) return { kind: "none" }
  const { systemHead, frozen } = base
  const middle = [...base.middle]
  const tail = [...base.tail]

  // Drain-line: evict the oldest tail messages into the summarize region until
  // the RETAINED content (head + frozen + tail; the new summary is bounded
  // separately) fits under retainedFraction*window. Floors at MIN_TAIL.
  if (typeof retainedFraction === "number" && retainedFraction > 0 && retainedFraction < 1) {
    const budget = retainedFraction * getContextWindow(modelId)
    while (tail.length > MIN_TAIL && estimateTokens([...systemHead, ...frozen, ...tail]) > budget) {
      middle.push(tail.shift())
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
