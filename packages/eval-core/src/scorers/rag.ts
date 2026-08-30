/**
 * RAG groundedness scorers (Ragas-style).
 *
 * Four metrics, split retrieval-vs-generation as Ragas does:
 *  - `faithfulness`       (L3) — fraction of answer statements supported by the
 *                                retrieved context (hallucination gate).
 *  - `answer-relevancy`   (L3) — how relevant the answer is to the question.
 *  - `context-precision`  (L3) — fraction of retrieved chunks that are relevant.
 *  - `context-recall`     (L1) — fraction of ground-truth context actually
 *                                retrieved (deterministic lexical overlap; no LLM).
 *
 * The three LLM-backed metrics approximate Ragas via a single statement/verdict
 * extraction call and fail open (a parse/provider error yields an `errored`
 * Score that decides nothing, never crashing the run). The LLM ones report
 * `not-applicable` when no retrieval happened; context-recall is
 * `not-applicable` without a `reference.expectedContext`. The two statuses are
 * distinct on purpose: "this dataset has no RAG references" and "the provider
 * is down" must not look alike in the report.
 */

import type { EvalJudgeClient } from "./judge-client"
import { extractJson } from "../json"
import type { EvalCase, EvalSample, Score, Scorer } from "../domain/eval"

export type RagMetric = "faithfulness" | "answer-relevancy" | "context-precision" | "context-recall"

export interface RagScorerOptions {
  metric: RagMetric
  /** Required for the three LLM-backed metrics; unused by context-recall. */
  client?: EvalJudgeClient
  /** Pass threshold (answer-relevancy / context-precision). Default 0.7. */
  threshold?: number
  maxTokens?: number
}

const RAG_SYSTEM =
  "You are a precise RAG evaluator. Output ONLY the requested JSON object — no prose."

function naScore(id: string, reason: string): Score {
  return {
    scorerId: id,
    dimension: "rag",
    status: "not-applicable",
    value: 0,
    passed: false,
    error: `not-applicable: ${reason}`,
  }
}

function errScore(id: string, message: string): Score {
  return {
    scorerId: id,
    dimension: "rag",
    status: "errored",
    value: 0,
    passed: false,
    error: message,
  }
}

function contextText(sample: EvalSample): string {
  return sample.retrievedChunks.map((c, i) => `[${i + 1}] ${c.text}`).join("\n")
}

async function callJson<T>(
  client: EvalJudgeClient,
  prompt: string,
  maxTokens: number
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let raw: string
  try {
    raw = await client.complete(prompt, { system: RAG_SYSTEM, temperature: 0, maxTokens })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    return { ok: true, value: extractJson<T>(raw) }
  } catch (err) {
    return {
      ok: false,
      error: `rag parse error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export function makeRagScorer(options: RagScorerOptions): Scorer {
  const { metric } = options
  const threshold = options.threshold ?? 0.7
  const maxTokens = options.maxTokens ?? 600
  const id = `rag-${metric}`
  const requiresLlm = metric !== "context-recall"

  return {
    id,
    dimension: "rag",
    requiresLlm,
    gating: true,
    async score(sample: EvalSample, evalCase: EvalCase): Promise<Score> {
      if (metric === "context-recall") {
        const expected = evalCase.reference?.expectedContext
        if (!expected || expected.length === 0) return naScore(id, "no expectedContext reference")
        const haystack = sample.retrievedChunks.map((c) => c.text.toLowerCase()).join("\n")
        const recalled = expected.filter((e) => haystack.includes(e.toLowerCase())).length
        const value = recalled / expected.length
        return {
          scorerId: id,
          dimension: "rag",
          status: "scored",
          value,
          passed: value >= 1,
          metadata: { recalled, total: expected.length },
        }
      }

      const client = options.client
      if (!client) return errScore(id, `${metric} requires an LLM client`)

      if (metric === "faithfulness") {
        if (sample.retrievedChunks.length === 0) return naScore(id, "no retrieved context")
        const prompt =
          `Given the CONTEXT and the ANSWER, break the answer into atomic statements and, ` +
          `for each, decide whether it can be directly inferred from the context.\n\n` +
          `CONTEXT:\n${contextText(sample)}\n\nANSWER:\n${sample.output}\n\n` +
          `Output JSON: {"statements":[{"text":"...","supported":true|false}]}`
        const res = await callJson<{ statements?: { supported?: unknown }[] }>(
          client,
          prompt,
          maxTokens
        )
        if (!res.ok) return errScore(id, res.error)
        const statements = Array.isArray(res.value.statements) ? res.value.statements : []
        if (statements.length === 0) {
          return {
            scorerId: id,
            dimension: "rag",
            status: "scored",
            value: 1,
            passed: true,
            metadata: { total: 0 },
          }
        }
        const supported = statements.filter((s) => s.supported === true).length
        const value = supported / statements.length
        return {
          scorerId: id,
          dimension: "rag",
          status: "scored",
          value,
          passed: value >= 1,
          metadata: { supported, total: statements.length },
        }
      }

      if (metric === "context-precision") {
        if (sample.retrievedChunks.length === 0) return naScore(id, "no retrieved context")
        const prompt =
          `For the QUESTION, decide for each retrieved CHUNK whether it is relevant ` +
          `(useful to answer the question).\n\nQUESTION:\n${evalCase.input}\n\n` +
          `CHUNKS:\n${contextText(sample)}\n\n` +
          `Output JSON: {"verdicts":[true|false, ...]} with one boolean per chunk in order.`
        const res = await callJson<{ verdicts?: unknown[] }>(client, prompt, maxTokens)
        if (!res.ok) return errScore(id, res.error)
        const verdicts = Array.isArray(res.value.verdicts) ? res.value.verdicts : []
        if (verdicts.length === 0) return errScore(id, "context-precision: empty verdicts")
        const relevant = verdicts.filter((v) => v === true).length
        const value = relevant / verdicts.length
        return {
          scorerId: id,
          dimension: "rag",
          status: "scored",
          value,
          passed: value >= threshold,
          metadata: { relevant, total: verdicts.length },
        }
      }

      // answer-relevancy
      const prompt =
        `Rate how directly the ANSWER addresses the QUESTION on a 0..1 scale ` +
        `(1 = fully on-point, 0 = irrelevant).\n\nQUESTION:\n${evalCase.input}\n\n` +
        `ANSWER:\n${sample.output}\n\nOutput JSON: {"relevancy": <number 0..1>}`
      const res = await callJson<{ relevancy?: unknown }>(client, prompt, maxTokens)
      if (!res.ok) return errScore(id, res.error)
      const relevancy = typeof res.value.relevancy === "number" ? res.value.relevancy : NaN
      if (!Number.isFinite(relevancy))
        return errScore(id, "answer-relevancy: missing relevancy number")
      const value = Math.max(0, Math.min(1, relevancy))
      return { scorerId: id, dimension: "rag", status: "scored", value, passed: value >= threshold }
    },
  }
}
