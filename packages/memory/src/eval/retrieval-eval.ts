/**
 * Labeled retrieval evaluation for memory recall — hit@k, recall@k and MRR over
 * a fixed golden set, per arm (a retriever configuration) and per question
 * category, with deltas against a baseline arm. Modeled on ai-memory's
 * LongMemEval harness (`evals/src/retrieval/score.rs`) and its in-repo
 * `recall_eval` floor test; ADR-0115 requires "fixed bilingual retrieval
 * evals", which this provides for the memory domain.
 *
 * Runs the REAL retriever (`retrieveMemoriesWithOutcome`) over in-memory deps,
 * so a ranking change anywhere in the pipeline shows up here. Deterministic:
 * the clock is fixed and the optional embedder is supplied by the caller.
 *
 * Pure — no I/O.
 */

import type { Memory, MemoryType } from "../types/memory"
import {
  retrieveMemoriesWithOutcome,
  type MemoryRetrieverDeps,
  type RetrieveMemoriesInput,
} from "../retrieve/retriever"
import { memoryIdentity } from "../lifecycle/revision"

export const EVAL_KS = [1, 3, 5] as const
export type EvalK = (typeof EVAL_KS)[number]

export interface RetrievalEvalQuestion {
  id: string
  query: string
  /** Memory identities (owner ids for revisions) that answer the question. */
  relevantIds: readonly string[]
  category: string
  /** Historical question: search memory as of this instant. */
  asOf?: number
  types?: MemoryType[]
}

export interface RetrievalEvalDataset {
  /** Every row, including revision snapshots and forgotten rows. */
  memories: readonly Memory[]
  questions: readonly RetrievalEvalQuestion[]
  /** Fixed clock for scoring and eligibility. */
  now: number
}

export interface RetrievalEvalArm {
  name: string
  /** Retriever input overrides (routing, belief weight, expansion …). */
  input?: Partial<
    Pick<
      RetrieveMemoriesInput,
      "sessionRecallRouting" | "beliefRankingWeight" | "enableQueryExpansion" | "rerank"
    >
  >
  /** Optional embedder; with it the arm runs hybrid (BM25 + vector). */
  embed?: (text: string) => number[] | Promise<number[]>
  /** Optional reranker for the arm. */
  rerank?: MemoryRetrieverDeps["rerank"]
}

export interface RetrievalMetrics {
  questions: number
  hitAt: Record<EvalK, number>
  recallAt: Record<EvalK, number>
  mrr: number
}

export interface RetrievalEvalQuestionResult {
  id: string
  category: string
  rankedIds: string[]
  /** 1-based rank of the first relevant hit; absent when none was retrieved. */
  firstRelevantRank?: number
}

export interface RetrievalEvalArmReport {
  arm: string
  overall: RetrievalMetrics
  byCategory: Record<string, RetrievalMetrics>
  perQuestion: RetrievalEvalQuestionResult[]
}

export interface RetrievalEvalReport {
  arms: RetrievalEvalArmReport[]
  /** `arm − baseline` on overall metrics, for every non-baseline arm. */
  deltas: {
    arm: string
    hitAt: Record<EvalK, number>
    recallAt: Record<EvalK, number>
    mrr: number
  }[]
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** In-memory retriever deps over the dataset; vectors computed once per arm. */
async function buildEvalDeps(
  dataset: RetrievalEvalDataset,
  arm: RetrievalEvalArm
): Promise<MemoryRetrieverDeps> {
  const active = dataset.memories.filter((memory) => memory.status === "active")
  const deps: MemoryRetrieverDeps = {
    loadCandidates: async () => active,
    loadHistoricalCandidates: async () => [...dataset.memories],
    vectorTimeoutMs: 60_000,
    ...(arm.rerank ? { rerank: arm.rerank } : {}),
  }
  if (arm.embed) {
    const vectors = new Map<string, number[]>()
    for (const memory of active) {
      if (memory.vectorDocId) vectors.set(memory.vectorDocId, await arm.embed(memory.text))
    }
    const embed = arm.embed
    deps.embed = async (text) => embed(text)
    deps.vectorSearch = async (embedding, topK, plan) => {
      const allowed = plan ? new Set(plan.vectorDocIds) : undefined
      return [...vectors.entries()]
        .filter(([id]) => !allowed || allowed.has(id))
        .map(([id, vector]) => ({ id, score: cosine(embedding, vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
    }
  }
  return deps
}

function emptyAt(): Record<EvalK, number> {
  return { 1: 0, 3: 0, 5: 0 }
}

/** Aggregate per-question results; recall@k is |relevant ∩ top-k| / |relevant|. */
export function scoreRetrieval(
  results: readonly { rankedIds: readonly string[]; relevantIds: readonly string[] }[]
): RetrievalMetrics {
  const hitAt = emptyAt()
  const recallAt = emptyAt()
  let reciprocal = 0
  for (const result of results) {
    const relevant = new Set(result.relevantIds)
    for (const k of EVAL_KS) {
      const top = result.rankedIds.slice(0, k)
      const found = top.filter((id) => relevant.has(id)).length
      if (found > 0) hitAt[k] += 1
      recallAt[k] += relevant.size === 0 ? 0 : found / relevant.size
    }
    const first = result.rankedIds.findIndex((id) => relevant.has(id))
    if (first >= 0) reciprocal += 1 / (first + 1)
  }
  const n = results.length
  const mean = (value: number) => (n === 0 ? 0 : value / n)
  return {
    questions: n,
    hitAt: { 1: mean(hitAt[1]), 3: mean(hitAt[3]), 5: mean(hitAt[5]) },
    recallAt: { 1: mean(recallAt[1]), 3: mean(recallAt[3]), 5: mean(recallAt[5]) },
    mrr: mean(reciprocal),
  }
}

export async function runRetrievalEval(
  dataset: RetrievalEvalDataset,
  arms: readonly RetrievalEvalArm[]
): Promise<RetrievalEvalReport> {
  const maxK = Math.max(...EVAL_KS)
  const reports: RetrievalEvalArmReport[] = []
  for (const arm of arms) {
    const deps = await buildEvalDeps(dataset, arm)
    const perQuestion: RetrievalEvalQuestionResult[] = []
    const scored: { category: string; rankedIds: string[]; relevantIds: readonly string[] }[] = []
    for (const question of dataset.questions) {
      const outcome = await retrieveMemoriesWithOutcome(
        {
          queryText: question.query,
          topK: maxK,
          // The floor would hide ranking differences the eval exists to see.
          relevanceFloor: 0,
          now: dataset.now,
          ...(question.types ? { types: question.types } : {}),
          ...(question.asOf !== undefined ? { asOf: question.asOf } : {}),
          ...arm.input,
        },
        deps
      )
      // Deduplicate by memory identity, keeping the best rank — a snapshot and
      // its owner answer the same question.
      const rankedIds: string[] = []
      for (const hit of outcome.hits) {
        const identity = memoryIdentity(hit.memory)
        if (!rankedIds.includes(identity)) rankedIds.push(identity)
      }
      const relevant = new Set(question.relevantIds)
      const first = rankedIds.findIndex((id) => relevant.has(id))
      perQuestion.push({
        id: question.id,
        category: question.category,
        rankedIds,
        ...(first >= 0 ? { firstRelevantRank: first + 1 } : {}),
      })
      scored.push({ category: question.category, rankedIds, relevantIds: question.relevantIds })
    }
    const byCategory: Record<string, RetrievalMetrics> = {}
    for (const category of new Set(scored.map((entry) => entry.category))) {
      byCategory[category] = scoreRetrieval(scored.filter((entry) => entry.category === category))
    }
    reports.push({ arm: arm.name, overall: scoreRetrieval(scored), byCategory, perQuestion })
  }

  const baseline = reports[0]
  const deltas = reports.slice(1).map((report) => ({
    arm: report.arm,
    hitAt: {
      1: report.overall.hitAt[1] - baseline.overall.hitAt[1],
      3: report.overall.hitAt[3] - baseline.overall.hitAt[3],
      5: report.overall.hitAt[5] - baseline.overall.hitAt[5],
    },
    recallAt: {
      1: report.overall.recallAt[1] - baseline.overall.recallAt[1],
      3: report.overall.recallAt[3] - baseline.overall.recallAt[3],
      5: report.overall.recallAt[5] - baseline.overall.recallAt[5],
    },
    mrr: report.overall.mrr - baseline.overall.mrr,
  }))
  return { arms: reports, deltas }
}

/** Plain-text table of a report (for `pnpm memory:eval`). */
export function formatRetrievalEvalReport(report: RetrievalEvalReport): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}`.padStart(5)
  const lines = ["arm                      hit@1 hit@3 hit@5  rec@5   MRR"]
  for (const arm of report.arms) {
    lines.push(
      `${arm.arm.padEnd(24)} ${pct(arm.overall.hitAt[1])} ${pct(arm.overall.hitAt[3])} ${pct(
        arm.overall.hitAt[5]
      )} ${pct(arm.overall.recallAt[5])} ${arm.overall.mrr.toFixed(3)}`
    )
    for (const [category, metrics] of Object.entries(arm.byCategory)) {
      lines.push(
        `  ${category.padEnd(22)} ${pct(metrics.hitAt[1])} ${pct(metrics.hitAt[3])} ${pct(
          metrics.hitAt[5]
        )} ${pct(metrics.recallAt[5])} ${metrics.mrr.toFixed(3)}`
      )
    }
  }
  return lines.join("\n")
}
