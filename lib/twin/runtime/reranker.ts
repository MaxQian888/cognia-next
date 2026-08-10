/**
 * Twin-RAG reranker (Phase 2).
 *
 * Background:
 *   Phase-1 RAG returns the top-K cosine matches from the vector store
 *   directly. Phase-2 introduces an optional reranker stage that takes a
 *   wider candidate pool (`topK * overFetch`), re-scores it against the
 *   user query with a richer signal, and keeps the top-K post-rerank.
 *
 * Two re-scoring strategies are supported:
 *   - a per-candidate `scorer` (the built-in key-free `lexicalRerankScorer`),
 *     and
 *   - a `batchScorer` that scores the whole pool in one shot — used by the
 *     model-backed LLM reranker (`createLlmRerankScorer`), which asks the twin's
 *     configured LLM to rate every candidate's relevance in a single call.
 *
 * When neither is supplied (or `model === "identity"`) the **identity
 * reranker** returns the candidates in their original cosine order.
 *
 * Pure module — no I/O, no React, no IndexedDB, no provider SDK imports. The
 * LLM reranker takes an injected `complete()` callback so this file stays pure;
 * `build-deps` supplies a real `createLlmClient` client. The Twin Settings UI
 * decides whether to call it; this file is only the algorithm.
 */

import { hasNoLeakingPii } from "@cognia/redact"

export interface RerankCandidate {
  /** Stable id from the vector store. */
  id: string
  /** Text content to score against the query. */
  content: string
  /** Initial similarity score from the cosine search. */
  score: number
  /** Optional source title (for tie-breaking). */
  sourceTitle?: string
}

export interface RerankerOptions {
  /** Model identifier; `"identity"` (or omitted) keeps the original order. */
  model?: "identity" | "bge-reranker-v2" | "cohere-rerank-3" | (string & {})
  /** Final number of candidates to keep after rerank. */
  topK: number
  /**
   * When supplied, the runtime delegates the rerank decision to this scorer.
   * Used by tests to inject deterministic ordering; the lexical model wires
   * this to {@link lexicalRerankScorer}.
   */
  scorer?: (
    query: string,
    candidate: RerankCandidate,
    opts?: { signal?: AbortSignal }
  ) => number | Promise<number>
  /**
   * When supplied, the runtime scores the WHOLE candidate pool in one call
   * (instead of one `scorer` call per candidate). The model-backed LLM
   * reranker sets this via {@link createLlmRerankScorer}. Must return one score
   * per candidate, in input order; a length mismatch or a non-finite score
   * fails the batch and the runtime falls back to identity order. Takes
   * precedence over `scorer` when both are set. The `signal` is aborted when the
   * timeout fires so a network-backed scorer can cancel its in-flight request
   * instead of leaking a slot + billing tokens after fallback.
   */
  batchScorer?: (
    query: string,
    candidates: readonly RerankCandidate[],
    opts?: { signal?: AbortSignal }
  ) => number[] | Promise<number[]>
  /**
   * Soft guard — if scoring takes longer than this many ms, the runtime aborts
   * the rerank and falls back to identity order. Default 1500 ms (raise it for
   * the LLM batch scorer, which makes a network call).
   */
  timeoutMs?: number
}

export interface RerankResult {
  candidates: RerankCandidate[]
  /** True when the rerank ran successfully end-to-end. */
  reranked: boolean
  /** Reason for falling back, if any. */
  fallbackReason?: string
}

const DEFAULT_TIMEOUT_MS = 1500

function identityRerank(candidates: readonly RerankCandidate[], topK: number): RerankResult {
  return {
    candidates: candidates.slice(0, Math.max(0, topK)),
    reranked: false,
    fallbackReason: "identity",
  }
}

/**
 * Rerank `candidates` against `query`. Returns a new array — never mutates
 * the input. Always resolves (no throws); failures degrade to the identity
 * order with `reranked: false` and a `fallbackReason`.
 */
export async function rerank(
  query: string,
  candidates: readonly RerankCandidate[],
  options: RerankerOptions
): Promise<RerankResult> {
  const topK = Math.max(0, options.topK)
  if (candidates.length === 0 || topK === 0) {
    return { candidates: [], reranked: false, fallbackReason: "empty-input" }
  }

  const model = options.model ?? "identity"
  const scorer = options.scorer
  const batchScorer = options.batchScorer
  if (model === "identity" || (!scorer && !batchScorer)) {
    return identityRerank(candidates, topK)
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Race the whole batch against a wall-clock timer so a hung scorer (e.g.
  // network outage to a remote reranker) cannot block the chat send.
  // `batchScorer` (one call for the pool — the LLM reranker) wins over the
  // per-candidate `scorer` (the lexical reranker) when both are set.
  // A shared controller lets the timeout (and any scoring failure) abort the
  // in-flight scorer request — otherwise a stalled provider keeps running and
  // billing tokens long after we've already fallen back to identity order.
  const controller = new AbortController()
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let scores: number[]
  try {
    scores = await Promise.race([
      batchScorer
        ? Promise.resolve(batchScorer(query, candidates, { signal: controller.signal })).then(
            (batch) => {
              if (!Array.isArray(batch) || batch.length !== candidates.length) {
                throw new Error("rerank batchScorer returned wrong-length score array")
              }
              for (const s of batch) {
                if (typeof s !== "number" || !Number.isFinite(s)) {
                  throw new Error("rerank batchScorer returned non-finite value")
                }
              }
              return batch
            }
          )
        : Promise.all(
            candidates.map(async (cand) => {
              const score = await scorer!(query, cand, { signal: controller.signal })
              if (typeof score !== "number" || !Number.isFinite(score)) {
                throw new Error("rerank scorer returned non-finite value")
              }
              return score
            })
          ),
      new Promise<number[]>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort()
          reject(new Error("rerank timeout"))
        }, timeoutMs)
      }),
    ])
  } catch (err) {
    // Abort the underlying request on any failure (timeout or a scorer throw)
    // so it stops consuming a slot / tokens once we fall back.
    controller.abort()
    const reason = err instanceof Error ? err.message : "rerank failed"
    return {
      candidates: identityRerank(candidates, topK).candidates,
      reranked: false,
      fallbackReason: reason,
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }

  const ranked = candidates
    .map((c, i) => ({ candidate: c, score: scores[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((entry) => ({ ...entry.candidate, score: entry.score }))

  return { candidates: ranked, reranked: true }
}

/**
 * Convenience: produce a stable identity scorer that returns the original
 * cosine score. Useful for tests that want to assert "no reordering".
 */
export function identityScorer(_query: string, c: RerankCandidate): number {
  return c.score
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter(Boolean))
}

/**
 * Built-in, key-free reranker. Re-scores each candidate by blending its
 * original cosine score with the fraction of the query's terms that appear in
 * the candidate content. Pure semantic search can rank a chunk high while
 * missing the exact terms the user asked about (proper nouns, ids, file paths);
 * the keyword-coverage term lifts those. Deterministic and local — no model /
 * API key required, so it's the default once reranking is enabled.
 */
export function lexicalRerankScorer(query: string, c: RerankCandidate): number {
  const queryTerms = tokenSet(query)
  if (queryTerms.size === 0) return c.score
  const contentTerms = tokenSet(c.content)
  let covered = 0
  for (const term of queryTerms) if (contentTerms.has(term)) covered += 1
  const coverage = covered / queryTerms.size
  // 70% original cosine signal, 30% keyword coverage. Keeps the semantic order
  // dominant while letting strong keyword matches climb.
  return 0.7 * c.score + 0.3 * coverage
}

/**
 * Minimal LLM surface the model-backed reranker needs — a subset of the twin
 * distill `LlmClient` (`lib/twin/distill/llm.ts`). Injected so this module
 * stays free of provider SDK imports.
 */
export interface RerankLlmClient {
  complete(
    prompt: string,
    options?: { system?: string; temperature?: number; abortSignal?: AbortSignal }
  ): Promise<string>
}

/** Max candidate content characters embedded in the rerank prompt (bounds cost). */
const LLM_RERANK_SNIPPET_CHARS = 500

const LLM_RERANK_SYSTEM =
  "You are a search result reranker. Given a query and a numbered list of " +
  "documents, rate how well each document answers the query on a scale from " +
  "0.0 (irrelevant) to 1.0 (directly answers it). Respond with ONLY a JSON " +
  "array of numbers — one score per document, in the same order. No prose."

function buildLlmRerankPrompt(query: string, candidates: readonly RerankCandidate[]): string {
  const docs = candidates
    .map((c, i) => {
      const snippet = c.content.slice(0, LLM_RERANK_SNIPPET_CHARS).replace(/\s+/g, " ").trim()
      return `[${i}] ${snippet}`
    })
    .join("\n")
  return (
    `Query: ${query}\n\n` +
    `Documents:\n${docs}\n\n` +
    `Return a JSON array of exactly ${candidates.length} relevance scores ` +
    `(0.0–1.0), one per document index, in order.`
  )
}

/**
 * Build a {@link RerankerOptions.batchScorer} backed by an LLM. It asks the
 * model to rate every candidate's relevance to the query in ONE call and
 * returns the parsed scores (clamped to [0, 1]). Throws on a malformed / wrong-
 * length response so `rerank` falls back to identity order — the caller
 * (`build-deps`) additionally falls back to the lexical scorer when the LLM is
 * unconfigured, so a half-set model id never silently disables reranking.
 */
export function createLlmRerankScorer(
  client: RerankLlmClient
): (
  query: string,
  candidates: readonly RerankCandidate[],
  opts?: { signal?: AbortSignal }
) => Promise<number[]> {
  return async (query, candidates, opts) => {
    if (
      !hasNoLeakingPii(query) ||
      candidates.some((candidate) => !hasNoLeakingPii(candidate.content))
    ) {
      throw new Error("llm rerank: PII gate rejected query or candidate content")
    }
    const raw = await client.complete(buildLlmRerankPrompt(query, candidates), {
      system: LLM_RERANK_SYSTEM,
      temperature: 0,
      ...(opts?.signal ? { abortSignal: opts.signal } : {}),
    })
    // Local, dependency-free parse: pull the first JSON array out of the reply.
    const start = raw.indexOf("[")
    const end = raw.lastIndexOf("]")
    if (start === -1 || end <= start) {
      throw new Error("llm rerank: no JSON array in response")
    }
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed) || parsed.length !== candidates.length) {
      throw new Error("llm rerank: score array length mismatch")
    }
    return parsed.map((v) => {
      const n = Number(v)
      if (!Number.isFinite(n)) throw new Error("llm rerank: non-finite score")
      // Clamp defensively — a model may emit 0–100 or a stray >1 value.
      return Math.min(1, Math.max(0, n))
    })
  }
}
