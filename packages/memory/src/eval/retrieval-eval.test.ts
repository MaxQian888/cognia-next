import { __resetMemoryBm25Cache } from "../retrieve/retriever"
import {
  GOLDEN_DATASET,
  GOLDEN_NEGATIVE_HISTORICAL,
  GOLDEN_NOW,
  GOLDEN_QUESTIONS,
} from "./golden-memory-set"
import {
  formatRetrievalEvalReport,
  runRetrievalEval,
  scoreRetrieval,
  type RetrievalEvalArm,
} from "./retrieval-eval"

/**
 * Deterministic stand-in embedder: character-trigram hashing into 256 dims.
 * It exists so the hybrid code path (vector leg + RRF) runs reproducibly in CI;
 * it is NOT a semantic model, and the hybrid arms' numbers say nothing about
 * real embedding quality — ai-memory measured that with a real local model
 * (hit@5 0.668 lexical → 0.823 hybrid on LongMemEval-S).
 */
function trigramEmbed(text: string): number[] {
  const vector = new Array<number>(256).fill(0)
  const normalized = ` ${text.toLocaleLowerCase().replace(/\s+/g, " ")} `
  for (let i = 0; i + 3 <= normalized.length; i++) {
    let hash = 2166136261
    for (const char of normalized.slice(i, i + 3)) {
      hash ^= char.codePointAt(0) ?? 0
      hash = Math.imul(hash, 16777619)
    }
    vector[Math.abs(hash) % 256] += 1
  }
  return vector
}

const ARMS: RetrievalEvalArm[] = [
  { name: "bm25" },
  { name: "bm25+session-routing", input: { sessionRecallRouting: true } },
  { name: "bm25+belief", input: { beliefRankingWeight: 1 } },
  { name: "hybrid", embed: trigramEmbed },
  {
    name: "hybrid+routing+belief",
    embed: trigramEmbed,
    input: { sessionRecallRouting: true, beliefRankingWeight: 1 },
  },
]

beforeEach(() => __resetMemoryBm25Cache())

describe("scoreRetrieval", () => {
  it("computes hit@k, recall@k and MRR", () => {
    const metrics = scoreRetrieval([
      { rankedIds: ["a", "b", "c"], relevantIds: ["a"] },
      { rankedIds: ["x", "y", "b"], relevantIds: ["b", "z"] },
      { rankedIds: ["x"], relevantIds: ["q"] },
    ])
    expect(metrics.questions).toBe(3)
    expect(metrics.hitAt[1]).toBeCloseTo(1 / 3)
    expect(metrics.hitAt[3]).toBeCloseTo(2 / 3)
    expect(metrics.recallAt[3]).toBeCloseTo((1 + 0.5 + 0) / 3)
    expect(metrics.mrr).toBeCloseTo((1 + 1 / 3 + 0) / 3)
  })

  it("is zero for an empty result set", () => {
    expect(scoreRetrieval([])).toEqual({
      questions: 0,
      hitAt: { 1: 0, 3: 0, 5: 0 },
      recallAt: { 1: 0, 3: 0, 5: 0 },
      mrr: 0,
    })
  })
})

describe("golden memory retrieval eval", () => {
  it("keeps every arm above the recall floor and reports deltas against bm25", async () => {
    const report = await runRetrievalEval(GOLDEN_DATASET, ARMS)
    if (process.env.MEMORY_EVAL_REPORT) {
      // `pnpm memory:eval` prints the table for a human to compare arms.
      console.log(formatRetrievalEvalReport(report))
    }
    expect(report.arms.map((arm) => arm.arm)).toEqual(ARMS.map((arm) => arm.name))
    expect(report.deltas).toHaveLength(ARMS.length - 1)
    for (const arm of report.arms) {
      expect(arm.overall.questions).toBe(GOLDEN_QUESTIONS.length)
      // Same floor ai-memory's in-repo recall eval enforces.
      expect(arm.overall.recallAt[5]).toBeGreaterThanOrEqual(0.7)
    }
  })

  it("session-recall routing never costs episode questions and leaves the rest alone", async () => {
    const report = await runRetrievalEval(GOLDEN_DATASET, [ARMS[0], ARMS[1]])
    const [base, routed] = report.arms
    expect(routed.byCategory.episode.hitAt[1]).toBeGreaterThanOrEqual(
      base.byCategory.episode.hitAt[1]
    )
    expect(routed.byCategory.episode.mrr).toBeGreaterThanOrEqual(base.byCategory.episode.mrr)
    // Questions without "last time"/"上次" are ranked exactly as before.
    for (const question of base.perQuestion.filter((entry) => entry.category !== "episode")) {
      const same = routed.perQuestion.find((entry) => entry.id === question.id)
      expect(same?.rankedIds).toEqual(question.rankedIds)
    }
  })

  it("belief weight ranks the corroborated memory first where lexical ranking cannot", async () => {
    const report = await runRetrievalEval(GOLDEN_DATASET, [ARMS[0], ARMS[2]])
    const [base, belief] = report.arms
    const rank = (arm: typeof base) =>
      arm.perQuestion.find((question) => question.id === "q-pnpm")?.firstRelevantRank
    expect(rank(base)).toBeGreaterThan(1)
    expect(rank(belief)).toBe(1)
  })

  it("answers historical questions from the text live at the instant", async () => {
    const report = await runRetrievalEval(GOLDEN_DATASET, [ARMS[0]])
    expect(report.arms[0].byCategory.historical.hitAt[1]).toBe(1)
  })

  it("returns nothing historically for memories learned later or forgotten earlier", async () => {
    const report = await runRetrievalEval(
      { memories: GOLDEN_DATASET.memories, questions: GOLDEN_NEGATIVE_HISTORICAL, now: GOLDEN_NOW },
      [ARMS[0]]
    )
    for (const question of report.arms[0].perQuestion) {
      expect(question.rankedIds).not.toContain("m-nvim")
      expect(question.rankedIds).not.toContain("m-old-editor")
    }
  })

  it("formats a readable table with one row per arm and category", async () => {
    const report = await runRetrievalEval(GOLDEN_DATASET, [ARMS[0]])
    const table = formatRetrievalEvalReport(report)
    expect(table.split("\n")[0]).toContain("hit@1")
    expect(table).toContain("bm25")
    expect(table).toContain("episode")
  })
})
