/**
 * Final-answer synthesis: grounded, cited prose drawn only from gathered
 * evidence.
 *
 * The model writes `[n]` markers against the EVIDENCE numbering (the order
 * sources appear in `state.knowledge`). Whatever it emits, this module then
 * renumbers the used markers in first-appearance order so the inline `[n]` and
 * the `citations` array (and any rendered Sources list) index identically —
 * previously the list was renumbered while the markers kept evidence indices,
 * so `[5]` could dangle or point at the wrong row.
 */
import { unwrapUntrustedContent } from "@cognia/plugin-sdk"

import type { AiBridge } from "../lib/ai"
import { completeText } from "../lib/ai"
import type { Citation } from "../types"
import { draftAnswerMessages } from "./prompts"
import { renderEvidence, type ResearchState } from "./workspace"

export async function draftAnswer(
  state: ResearchState,
  ai: AiBridge,
  beast: boolean
): Promise<{ answer: string; citations: Citation[]; tokens: number }> {
  const evidence = renderEvidence(state)
  const { text, tokens } = await completeText(
    ai,
    draftAnswerMessages(state.question, evidence, beast, state.config.locale),
    { temperature: 0.3, maxTokens: 2_000 }
  )
  const { answer, citations } = alignCitations(stripSourcesTail(text), state)
  return { answer, citations, tokens }
}

/**
 * Rewrite the answer's `[n]` markers into a compact 1..k numbering ordered by
 * first appearance, and return the matching citation list. Markers outside
 * `1..knowledge.length` are left untouched — they are literal brackets (years,
 * footnote-like text), not citations. When nothing valid is cited the list
 * falls back to every gathered source, as before.
 */
export function alignCitations(
  answer: string,
  state: ResearchState
): { answer: string; citations: Citation[] } {
  const toCitation = (n: number): Citation => {
    const k = state.knowledge[n - 1]
    // The untrusted banner is prompt-facing chrome; it must not end up as the
    // link label in a user-visible Sources list.
    return {
      url: k.url,
      title: unwrapUntrustedContent(k.title),
      ...(k.publishedDate ? { publishedDate: k.publishedDate } : {}),
    }
  }

  const order: number[] = []
  const seen = new Set<number>()
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1])
    if (n >= 1 && n <= state.knowledge.length && !seen.has(n)) {
      seen.add(n)
      order.push(n)
    }
  }
  if (order.length === 0) {
    return { answer, citations: state.knowledge.map((_, i) => toCitation(i + 1)) }
  }
  const remap = new Map(order.map((n, i) => [n, i + 1]))
  const rewritten = answer.replace(/\[(\d+)\]/g, (match, digits: string) => {
    const next = remap.get(Number(digits))
    return next === undefined ? match : `[${next}]`
  })
  return { answer: rewritten, citations: order.map(toCitation) }
}

/**
 * Remove a trailing model-written "Sources" section. The plugin appends a
 * canonical, deduplicated list itself, and the draft prompt no longer asks the
 * model for one — this stays as a defensive strip for models that emit one
 * anyway, and for section answers flowing into the report weave.
 */
export function stripSourcesTail(text: string): string {
  return text
    .replace(
      /\n+(?:#{1,6}\s+|\*\*)?sources:?[^\n]*(?:\*\*)?\s*\n(?:\s*(?:[-*+]|\d+[.)]|\[\d+\]|https?:\/\/)[^\n]*\n?)+\s*$/i,
      "\n"
    )
    .trimEnd()
}
