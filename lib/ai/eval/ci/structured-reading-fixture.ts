import type { EvalRetrievedChunk, EvalSample, Score } from "@cognia/eval-core/domain/eval"
import { makeRagScorer } from "@cognia/eval-core/scorers/rag"
import type { LongDocumentFixture } from "@cognia/eval-core/fixtures/long-document"

export interface StructuredReadingEvaluationAdapter {
  /** Adapters must return only executed, authorized reads; never outline summaries. */
  retrieveFast(query: string): Promise<EvalRetrievedChunk[]>
  readOriginal(sectionTitle: string): Promise<EvalRetrievedChunk[]>
}

export interface StructuredReadingEvaluationResult {
  caseId: string
  mode: "fast-rag" | "progressive"
  sample: EvalSample
  recall: Score
  faithfulness: Score
  answerCorrect: boolean
  abstained: boolean
}

export const STRUCTURED_READING_ABSTENTION = "No supported answer found."

/**
 * A deterministic integration driver, not a model quality benchmark. It scores
 * real adapter context with the existing RAG metrics. The answer and judge are
 * exact-match synthetic oracles, making failures repeatable and free of paid calls.
 */
export async function runStructuredReadingEvaluation(
  fixture: LongDocumentFixture,
  adapter: StructuredReadingEvaluationAdapter
): Promise<StructuredReadingEvaluationResult[]> {
  const results: StructuredReadingEvaluationResult[] = []
  const recall = makeRagScorer({ metric: "context-recall" })
  for (const entry of fixture.cases) {
    for (const mode of ["fast-rag", "progressive"] as const) {
      const chunks =
        mode === "fast-rag"
          ? await adapter.retrieveFast(entry.evalCase.input)
          : await adapter.readOriginal(entry.sectionTitle)
      const supported =
        entry.answer !== null && chunks.some(({ text }) => text.includes(entry.answer!))
      const output = supported ? entry.answer! : STRUCTURED_READING_ABSTENTION
      const sample: EvalSample = {
        output,
        retrievedChunks: chunks,
        // The fixture runs service adapters, so it does not invent Agent traces.
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        stepCount: 0,
        degraded: false,
      }
      const faithfulness = makeRagScorer({
        metric: "faithfulness",
        client: {
          complete: async () =>
            JSON.stringify({
              statements:
                output === STRUCTURED_READING_ABSTENTION
                  ? []
                  : [{ text: output, supported: chunks.some(({ text }) => text.includes(output)) }],
            }),
        },
      })
      results.push({
        caseId: entry.evalCase.id,
        mode,
        sample,
        recall: await recall.score(sample, entry.evalCase),
        faithfulness: await faithfulness.score(sample, entry.evalCase),
        answerCorrect: output === (entry.answer ?? STRUCTURED_READING_ABSTENTION),
        abstained: output === STRUCTURED_READING_ABSTENTION,
      })
    }
  }
  return results
}
