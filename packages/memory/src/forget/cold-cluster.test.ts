import type { Memory } from "../types/memory"
import {
  DEFAULT_DEDUP_MAX_EPS,
  DEFAULT_DEDUP_MIN_PTS,
  planColdClusterDedup,
  type ColdClusterCandidate,
} from "./cold-cluster"

const NOW = 1_700_000_000_000
const at = (angle: number): number[] => [Math.cos(angle), Math.sin(angle)]

function mem(id: string, text: string, over: Partial<Memory> = {}): Memory {
  return {
    id,
    scope: "global",
    type: "episodic",
    text,
    tags: [],
    importance: 5,
    createdAt: NOW,
    updatedAt: NOW,
    lastAccessedAt: NOW,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

function candidate(
  memory: Memory,
  retention: number,
  embedding: readonly number[]
): ColdClusterCandidate {
  return { memory, retention, embedding }
}

const A = mem("a", "Build broke on the CI runner.\n\nThe failing file was src/a.ts.")
const B = mem("b", "Build broke on CI again.\n\nThe compiler reported E0433.")
const C = mem("c", "CI build was broken.\n\nIt only happened when NODE_ENV was unset.")
const D = mem("d", "We planned the team offsite.")

describe("planColdClusterDedup", () => {
  it("exposes ai-memory's defaults", () => {
    expect(DEFAULT_DEDUP_MIN_PTS).toBe(2)
    expect(DEFAULT_DEDUP_MAX_EPS).toBe(0.15)
  })

  it("folds near-duplicates into the highest-retention survivor", () => {
    const plan = planColdClusterDedup([
      candidate(A, 0.1, at(0)),
      candidate(B, 0.15, at(0.001)),
      candidate(D, 0.12, at(1.5)),
      candidate(C, 0.05, at(0.002)),
    ])
    expect(plan.eps).not.toBeNull()
    expect(plan.eps!).toBeLessThanOrEqual(DEFAULT_DEDUP_MAX_EPS)
    expect(plan.merges).toHaveLength(1)
    const [merge] = plan.merges
    expect(merge.survivor).toBe(B)
    expect(merge.merged).toEqual([A, C])
    expect(merge.merged).not.toContain(D)
  })

  it("keeps the survivor's statement as summary and absorbs every member's durable tokens", () => {
    const plan = planColdClusterDedup([
      candidate(A, 0.1, at(0)),
      candidate(B, 0.15, at(0.001)),
      candidate(C, 0.05, at(0.002)),
      candidate(D, 0.12, at(1.5)),
    ])
    const { survivorText } = plan.merges[0]
    expect(survivorText.startsWith("Build broke on CI again.")).toBe(true)
    expect(survivorText).toContain("src/a.ts")
    expect(survivorText).toContain("E0433")
    expect(survivorText).toContain("NODE_ENV")
  })

  it("picks the first member on retention ties", () => {
    const plan = planColdClusterDedup([
      candidate(A, 0.1, at(0)),
      candidate(B, 0.1, at(0)),
      candidate(C, 0.1, at(0)),
    ])
    expect(plan.merges[0].survivor).toBe(A)
    expect(plan.merges[0].merged).toEqual([B, C])
  })

  it("excludes already-compacted rows from the candidate set", () => {
    const compacted = mem("x", "Compacted before. See src/x.ts", { compactedAt: NOW })
    const plan = planColdClusterDedup([
      candidate(compacted, 0.9, at(0)),
      candidate(A, 0.1, at(0.001)),
      candidate(B, 0.15, at(0.002)),
      candidate(C, 0.05, at(0.003)),
    ])
    expect(plan.merges).toHaveLength(1)
    const [merge] = plan.merges
    expect(merge.survivor).toBe(B)
    expect([merge.survivor, ...merge.merged]).not.toContain(compacted)
    expect(merge.survivorText).not.toContain("src/x.ts")
  })

  it("ignores candidates without an embedding", () => {
    const plan = planColdClusterDedup([
      candidate(D, 0.9, []),
      candidate(A, 0.1, at(0)),
      candidate(B, 0.15, at(0.001)),
      candidate(C, 0.05, at(0.002)),
    ])
    expect(plan.merges).toHaveLength(1)
    expect(plan.merges[0].survivor).toBe(B)
    expect(plan.merges[0].merged).not.toContain(D)
  })

  it("returns eps null when fewer than minPts candidates are eligible", () => {
    expect(planColdClusterDedup([])).toEqual({ eps: null, merges: [] })
    expect(planColdClusterDedup([candidate(A, 0.1, at(0))])).toEqual({ eps: null, merges: [] })
    expect(
      planColdClusterDedup([
        candidate(A, 0.1, at(0)),
        candidate({ ...B, compactedAt: NOW }, 0.1, at(0)),
      ])
    ).toEqual({ eps: null, merges: [] })
  })

  it("merges a group of exactly two near-identical rows with the default minPts", () => {
    const plan = planColdClusterDedup([candidate(A, 0.1, at(0)), candidate(B, 0.2, at(0))])
    expect(plan.eps).not.toBeNull()
    expect(plan.eps!).toBeCloseTo(0, 12)
    expect(plan.merges).toHaveLength(1)
    expect(plan.merges[0].survivor).toBe(B)
    expect(plan.merges[0].merged).toEqual([A])
    expect(plan.merges[0].survivorText).toContain("src/a.ts")
  })

  it("derives the pair's radius from their distance, clamped to maxEps", () => {
    const close = planColdClusterDedup([candidate(A, 0.1, at(0)), candidate(B, 0.2, at(0.1))])
    expect(close.eps!).toBeCloseTo(1 - Math.cos(0.1), 12)
    expect(close.merges).toHaveLength(1)
  })

  it("does not merge two far-apart rows (cosine distance > 0.15)", () => {
    // 1 − cos(0.6) ≈ 0.175
    const plan = planColdClusterDedup([candidate(A, 0.1, at(0)), candidate(B, 0.2, at(0.6))])
    expect(plan.eps).toBe(DEFAULT_DEDUP_MAX_EPS)
    expect(plan.merges).toEqual([])
  })

  it("returns eps null when the k-distance is undefined", () => {
    // minPts 1 → k = max(1, 0) = 1, and a single point has no 1st neighbour.
    expect(planColdClusterDedup([candidate(A, 0.1, at(0))], { minPts: 1 })).toEqual({
      eps: null,
      merges: [],
    })
  })

  it("caps the radius at maxEps so dissimilar vectors never merge", () => {
    // Consecutive gaps: 1 − cos(0.6) ≈ 0.175 > 0.15.
    const spread = [
      candidate(A, 0.1, at(0)),
      candidate(B, 0.2, at(0.6)),
      candidate(C, 0.3, at(1.2)),
    ]
    const capped = planColdClusterDedup(spread)
    expect(capped.eps).toBe(DEFAULT_DEDUP_MAX_EPS)
    expect(capped.merges).toEqual([])
    // A looser cap would chain them together.
    const loose = planColdClusterDedup(spread, { maxEps: 0.5 })
    expect(loose.merges).toHaveLength(1)
  })

  it("falls back to defaults for non-positive options", () => {
    const input = [candidate(A, 0.1, at(0)), candidate(B, 0.2, at(0.6)), candidate(C, 0.3, at(1.2))]
    expect(planColdClusterDedup(input, { minPts: 0, maxEps: -1 })).toEqual(
      planColdClusterDedup(input)
    )
  })

  it("uses the survivor's text when compaction yields nothing", () => {
    const heading1 = mem("h1", "# heading only")
    const heading2 = mem("h2", "# heading only too")
    const heading3 = mem("h3", "# another heading")
    const plan = planColdClusterDedup([
      candidate(heading1, 0.3, at(0)),
      candidate(heading2, 0.1, at(0.001)),
      candidate(heading3, 0.2, at(0.002)),
    ])
    expect(plan.merges[0].survivor).toBe(heading1)
    expect(plan.merges[0].survivorText).toBe("# heading only")
  })
})
