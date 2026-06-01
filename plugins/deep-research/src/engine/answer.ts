/**
 * Final-answer synthesis: grounded, cited prose drawn only from gathered
 * evidence. Citations are derived from the `[n]` markers the model actually
 * used (mapping back to `state.knowledge`), falling back to all read sources.
 */
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
  return { answer: text, citations: citationsFor(text, state), tokens }
}

/** Map `[n]` markers used in the answer to their knowledge sources. */
export function citationsFor(answer: string, state: ResearchState): Citation[] {
  const used = new Set<number>()
  const re = /\[(\d+)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(answer)) !== null) {
    const idx = Number(m[1])
    if (idx >= 1 && idx <= state.knowledge.length) used.add(idx)
  }
  const source =
    used.size > 0 ? [...used].sort((a, b) => a - b) : state.knowledge.map((_, i) => i + 1)
  return source.map((n) => {
    const k = state.knowledge[n - 1]
    return { url: k.url, title: k.title }
  })
}
