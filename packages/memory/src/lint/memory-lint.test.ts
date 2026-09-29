import type { Memory } from "../types/memory"
import {
  CONTRADICTION_MAX_FINDINGS,
  CONTRADICTION_MAX_MEMORIES,
  CONTRADICTION_SIM_HIGH,
  CONTRADICTION_SIM_LOW,
  detectSuspectedContradictions,
  lintMemories,
  MAX_FINDINGS_PER_KIND,
  MEMORY_LINT_KINDS,
  PENDING_INSTRUCTION_REVIEW_DAYS,
  type MemoryLintKind,
} from "./memory-lint"

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

let seq = 0
function mem(over: Partial<Memory> = {}): Memory {
  seq += 1
  return {
    id: over.id ?? `m${String(seq).padStart(4, "0")}`,
    scope: "global",
    type: "semantic",
    text: `unique memory ${seq}`,
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

/** Unit vector whose cosine similarity with `at(0)` is exactly `sim`. */
function withSim(sim: number): number[] {
  return [sim, Math.sqrt(1 - sim * sim)]
}

function ofKind(memories: Memory[], kind: MemoryLintKind, options = {}) {
  return lintMemories(memories, { now: NOW, ...options }).filter((f) => f.kind === kind)
}

describe("constants", () => {
  it("lists nine checks in order", () => {
    expect(MEMORY_LINT_KINDS).toEqual([
      "stale",
      "cold_episodic",
      "pinned_expiring",
      "duplicate",
      "feedback_flagged",
      "conflict_open",
      "missing_evidence",
      "pending_instruction_aging",
      "suspected_contradiction",
    ])
    expect(CONTRADICTION_SIM_LOW).toBe(0.4)
    expect(CONTRADICTION_SIM_HIGH).toBe(0.75)
    expect(MAX_FINDINGS_PER_KIND).toBe(25)
  })
})

describe("lintMemories", () => {
  it("returns no findings for a healthy store", () => {
    expect(lintMemories([mem(), mem({ type: "episodic" })], { now: NOW })).toEqual([])
    expect(lintMemories([], { now: NOW })).toEqual([])
  })

  it("ignores invalidated rows and revision snapshots", () => {
    const old = { type: "episodic" as const, createdAt: NOW - 400 * DAY }
    const findings = lintMemories(
      [
        mem({ ...old, status: "invalidated" }),
        mem({ ...old, revisionOf: "owner" }),
        mem({ reviewStatus: "conflict", status: "invalidated" }),
      ],
      { now: NOW }
    )
    expect(findings).toEqual([])
  })

  describe("stale", () => {
    it("flags an episodic memory older than 0.6/λ days never recalled", () => {
      const m = mem({ id: "old", type: "episodic", createdAt: NOW - 31 * DAY })
      expect(ofKind([m], "stale")).toEqual([
        { kind: "stale", severity: "info", memoryIds: ["old"], metrics: { ageDays: 31 } },
      ])
    })

    it("does not flag young, recalled, pinned or non-episodic rows", () => {
      const old = NOW - 100 * DAY
      expect(
        ofKind(
          [
            mem({ type: "episodic", createdAt: NOW - 29 * DAY }),
            mem({ type: "episodic", createdAt: old, accessCount: 1 }),
            mem({ type: "episodic", createdAt: old, pinned: true }),
            mem({ type: "semantic", createdAt: old }),
            mem({ type: "episodic", createdAt: old, revisedAt: NOW - DAY }),
          ],
          "stale"
        )
      ).toEqual([])
    })

    it("scales the threshold with λ", () => {
      const m = mem({ type: "episodic", createdAt: NOW - 10 * DAY })
      // λ = 0.1 → 6 days
      expect(ofKind([m], "stale", { retention: { lambda: 0.1 } })).toHaveLength(1)
      // λ = 0 → falls back to 30 days
      expect(ofKind([m], "stale", { retention: { lambda: 0 } })).toEqual([])
    })
  })

  describe("cold_episodic", () => {
    it("flags decayable rows below the cold threshold", () => {
      const m = mem({ id: "cold", type: "episodic", createdAt: NOW - 200 * DAY })
      const [finding] = ofKind([m], "cold_episodic")
      expect(finding.memoryIds).toEqual(["cold"])
      expect(finding.severity).toBe("info")
      expect(finding.metrics?.retention).toBeCloseTo(Math.exp(-0.02 * 200), 3)
    })

    it("skips compacted, non-decayable and warm rows", () => {
      const old = NOW - 200 * DAY
      expect(
        ofKind(
          [
            mem({ type: "episodic", createdAt: old, compactedAt: NOW - DAY }),
            mem({ type: "episodic", createdAt: old, pinned: true }),
            mem({ type: "semantic", createdAt: old }),
            mem({ type: "episodic", createdAt: old, projectMemoryKind: "state" }),
            mem({ type: "episodic", createdAt: NOW - DAY }),
            mem({
              type: "episodic",
              createdAt: old,
              accessCount: 20,
              lastAccessedAt: NOW - DAY,
            }),
          ],
          "cold_episodic"
        )
      ).toEqual([])
    })

    it("honours a custom cold threshold", () => {
      const m = mem({ type: "episodic", createdAt: NOW - 10 * DAY })
      expect(ofKind([m], "cold_episodic")).toEqual([])
      expect(ofKind([m], "cold_episodic", { coldThreshold: 0.9 })).toHaveLength(1)
    })
  })

  describe("pinned_expiring", () => {
    it("flags a pinned row with an explicit expiry", () => {
      const m = mem({ id: "p", pinned: true, expiresAt: NOW + 2.5 * DAY })
      expect(ofKind([m], "pinned_expiring")).toEqual([
        {
          kind: "pinned_expiring",
          severity: "warning",
          memoryIds: ["p"],
          metrics: { daysUntilExpiry: 3 },
        },
      ])
    })

    it("ignores unpinned rows and pinned rows without expiry", () => {
      expect(
        ofKind(
          [
            mem({ expiresAt: NOW + DAY }),
            mem({ pinned: true, expiresAt: null }),
            mem({ pinned: true }),
          ],
          "pinned_expiring"
        )
      ).toEqual([])
    })
  })

  describe("duplicate", () => {
    it("groups rows with the same normalized text in one namespace", () => {
      const a = mem({ id: "a", text: "User prefers  PNPM" })
      const b = mem({ id: "b", text: "user prefers pnpm " })
      const c = mem({ id: "c", text: "user prefers pnpm" })
      expect(ofKind([a, b, c], "duplicate")).toEqual([
        {
          kind: "duplicate",
          severity: "warning",
          memoryIds: ["a", "b", "c"],
          metrics: { count: 3 },
        },
      ])
    })

    it("does not group across namespaces", () => {
      const text = "same statement"
      expect(
        ofKind(
          [
            mem({ text }),
            mem({ text, scope: "character", characterId: "c1" }),
            mem({ text, scope: "character", characterId: "c2" }),
            mem({ text, projectId: "p1" }),
            mem({ text, branch: "main" }),
            mem({ text, projectId: "p1", projectMemoryKind: "state" }),
          ],
          "duplicate"
        )
      ).toEqual([])
    })

    it("groups rows sharing a stable key", () => {
      const a = mem({ id: "a", text: "use npm", key: "Pkg-Manager" })
      const b = mem({ id: "b", text: "use pnpm", key: " pkg-manager " })
      expect(ofKind([a, b], "duplicate")).toEqual([
        expect.objectContaining({ memoryIds: ["a", "b"], metrics: { count: 2 } }),
      ])
    })

    it("does not group equal keys across namespaces", () => {
      expect(
        ofKind([mem({ key: "k" }), mem({ key: "k", scope: "agent", agentId: "a1" })], "duplicate")
      ).toEqual([])
    })

    it("reports a group matched by both text and key once", () => {
      const a = mem({ id: "a", text: "same", key: "k" })
      const b = mem({ id: "b", text: "same", key: "k" })
      expect(ofKind([a, b], "duplicate")).toHaveLength(1)
    })

    it("ignores blank text and keys", () => {
      expect(
        ofKind([mem({ text: "  ", key: " " }), mem({ text: "", key: "" })], "duplicate")
      ).toEqual([])
    })
  })

  describe("feedback_flagged", () => {
    it("flags net-negative feedback and user-marked stale rows", () => {
      const down = mem({ id: "down", retrievalFeedback: { positive: 1, negative: 2 } })
      const stale = mem({ id: "stale", staleness: "stale" })
      expect(ofKind([down, stale], "feedback_flagged")).toEqual([
        {
          kind: "feedback_flagged",
          severity: "warning",
          memoryIds: ["down"],
          metrics: { positive: 1, negative: 2 },
        },
        {
          kind: "feedback_flagged",
          severity: "warning",
          memoryIds: ["stale"],
          metrics: { positive: 0, negative: 0 },
        },
      ])
    })

    it("ignores balanced or positive feedback", () => {
      expect(
        ofKind(
          [
            mem({ retrievalFeedback: { positive: 2, negative: 2 } }),
            mem({ retrievalFeedback: { positive: 3, negative: 0 } }),
            mem({ staleness: "fresh" }),
          ],
          "feedback_flagged"
        )
      ).toEqual([])
    })
  })

  describe("conflict_open", () => {
    it("lists the conflicted row first, then its counterparts", () => {
      const m = mem({ id: "x", reviewStatus: "conflict", conflictWithIds: ["y", "z"] })
      expect(ofKind([m], "conflict_open")).toEqual([
        {
          kind: "conflict_open",
          severity: "warning",
          memoryIds: ["x", "y", "z"],
          metrics: { count: 2 },
        },
      ])
    })

    it("handles a conflict without counterpart ids", () => {
      expect(ofKind([mem({ id: "x", reviewStatus: "conflict" })], "conflict_open")).toEqual([
        expect.objectContaining({ memoryIds: ["x"], metrics: { count: 0 } }),
      ])
    })

    it("ignores other review states", () => {
      expect(ofKind([mem({ reviewStatus: "verified" })], "conflict_open")).toEqual([])
    })
  })

  describe("missing_evidence", () => {
    it("flags supported rows whose evidence is all revoked", () => {
      const m = mem({
        id: "e",
        evidenceState: "supported",
        beliefInputs: { evidenceCount: 0, distinctSessions: 0 },
      })
      expect(ofKind([m], "missing_evidence")).toEqual([
        { kind: "missing_evidence", severity: "info", memoryIds: ["e"] },
      ])
    })

    it("ignores rows with live evidence, unknown inputs or legacy state", () => {
      expect(
        ofKind(
          [
            mem({
              evidenceState: "supported",
              beliefInputs: { evidenceCount: 1, distinctSessions: 1 },
            }),
            mem({ evidenceState: "supported" }),
            mem({
              evidenceState: "legacy",
              beliefInputs: { evidenceCount: 0, distinctSessions: 0 },
            }),
          ],
          "missing_evidence"
        )
      ).toEqual([])
    })
  })

  describe("pending_instruction_aging", () => {
    it(`flags a pending instruction waiting over ${PENDING_INSTRUCTION_REVIEW_DAYS} days`, () => {
      const m = mem({
        id: "pi",
        type: "procedural",
        reviewStatus: "pending_instruction",
        createdAt: NOW - 15.5 * DAY,
      })
      expect(ofKind([m], "pending_instruction_aging")).toEqual([
        {
          kind: "pending_instruction_aging",
          severity: "info",
          memoryIds: ["pi"],
          metrics: { waitedDays: 15 },
        },
      ])
    })

    it("ignores recent pending instructions and other statuses", () => {
      expect(
        ofKind(
          [
            mem({ reviewStatus: "pending_instruction", createdAt: NOW - 14 * DAY }),
            mem({ reviewStatus: "verified", createdAt: NOW - 100 * DAY }),
          ],
          "pending_instruction_aging"
        )
      ).toEqual([])
    })
  })

  describe("suspected_contradiction", () => {
    it("flags durable pairs in the similarity band", () => {
      const a = mem({ id: "a" })
      const b = mem({ id: "b" })
      const embeddings = new Map([
        ["a", [1, 0]],
        ["b", withSim(0.6)],
      ])
      expect(ofKind([a, b], "suspected_contradiction", { embeddings })).toEqual([
        {
          kind: "suspected_contradiction",
          severity: "info",
          memoryIds: ["a", "b"],
          metrics: { similarity: 0.6 },
        },
      ])
    })

    it("is skipped without embeddings or with fewer than two vectors", () => {
      const a = mem({ id: "a" })
      const b = mem({ id: "b" })
      expect(ofKind([a, b], "suspected_contradiction")).toEqual([])
      expect(
        ofKind([a, b], "suspected_contradiction", { embeddings: new Map([["a", [1, 0]]]) })
      ).toEqual([])
    })
  })

  it(`caps each kind at ${MAX_FINDINGS_PER_KIND} findings without starving others`, () => {
    const many = Array.from({ length: 40 }, () => mem({ reviewStatus: "conflict" }))
    const flagged = mem({ staleness: "stale" })
    const findings = lintMemories([...many, flagged], { now: NOW })
    expect(findings.filter((f) => f.kind === "conflict_open")).toHaveLength(MAX_FINDINGS_PER_KIND)
    expect(findings.filter((f) => f.kind === "feedback_flagged")).toHaveLength(1)
  })

  it("emits findings in check order", () => {
    const findings = lintMemories(
      [
        mem({ reviewStatus: "conflict" }),
        mem({ pinned: true, expiresAt: NOW + DAY }),
        mem({ type: "episodic", createdAt: NOW - 100 * DAY }),
      ],
      { now: NOW }
    )
    const order = findings.map((f) => MEMORY_LINT_KINDS.indexOf(f.kind))
    expect(order).toEqual([...order].sort((x, y) => x - y))
    expect(findings.map((f) => f.kind)).toEqual([
      "stale",
      "cold_episodic",
      "pinned_expiring",
      "conflict_open",
    ])
  })

  it("defaults the clock to Date.now()", () => {
    const spy = jest.spyOn(Date, "now").mockReturnValue(NOW + 40 * DAY)
    try {
      const findings = lintMemories([mem({ type: "episodic" })])
      expect(findings.map((f) => f.kind)).toContain("stale")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("detectSuspectedContradictions", () => {
  const pair = (simB: number) =>
    new Map([
      ["a", [1, 0]],
      ["b", withSim(simB)],
    ])

  it("includes the lower bound and excludes the upper bound", () => {
    const a = mem({ id: "a" })
    const b = mem({ id: "b" })
    expect(detectSuspectedContradictions([a, b], pair(0.4))).toHaveLength(1)
    expect(detectSuspectedContradictions([a, b], pair(0.7499))).toHaveLength(1)
    expect(detectSuspectedContradictions([a, b], pair(0.75))).toEqual([])
    expect(detectSuspectedContradictions([a, b], pair(0.39))).toEqual([])
    expect(detectSuspectedContradictions([a, b], pair(0.95))).toEqual([])
  })

  it("lists the newer memory first", () => {
    const older = mem({ id: "a", createdAt: NOW - 10 * DAY })
    const newer = mem({ id: "b", createdAt: NOW - 20 * DAY, revisedAt: NOW })
    expect(detectSuspectedContradictions([older, newer], pair(0.5))[0].memoryIds).toEqual([
      "b",
      "a",
    ])
    const newerByCreation = mem({ id: "a", createdAt: NOW })
    const olderByCreation = mem({ id: "b", createdAt: NOW - DAY })
    expect(
      detectSuspectedContradictions([newerByCreation, olderByCreation], pair(0.5))[0].memoryIds
    ).toEqual(["a", "b"])
  })

  it("never pairs memories from different namespaces", () => {
    const a = mem({ id: "a" })
    const b = mem({ id: "b", scope: "character", characterId: "c1" })
    expect(detectSuspectedContradictions([a, b], pair(0.6))).toEqual([])
    const c = mem({ id: "b", projectId: "p1" })
    expect(detectSuspectedContradictions([a, c], pair(0.6))).toEqual([])
  })

  it("only compares durable, active, non-conflicted rows with vectors", () => {
    const a = mem({ id: "a" })
    for (const b of [
      mem({ id: "b", type: "episodic" }),
      mem({ id: "b", status: "invalidated" }),
      mem({ id: "b", revisionOf: "a" }),
      mem({ id: "b", reviewStatus: "conflict" }),
    ]) {
      expect(detectSuspectedContradictions([a, b], pair(0.6))).toEqual([])
    }
    expect(detectSuspectedContradictions([a, mem({ id: "c" })], pair(0.6))).toEqual([])
    expect(
      detectSuspectedContradictions([a, mem({ id: "b", type: "procedural" })], pair(0.6))
    ).toHaveLength(1)
  })

  it("rounds similarity to two decimals", () => {
    const out = detectSuspectedContradictions([mem({ id: "a" }), mem({ id: "b" })], pair(0.4567))
    expect(out[0].metrics.similarity).toBe(0.46)
  })

  it(`caps findings at ${CONTRADICTION_MAX_FINDINGS}`, () => {
    // Alternate two directions 0.6 apart: every cross pair is in the band.
    const memories = Array.from({ length: 12 }, (_, i) =>
      mem({ id: `r${String(i).padStart(2, "0")}` })
    )
    const embeddings = new Map(memories.map((m, i) => [m.id, i % 2 === 0 ? [1, 0] : withSim(0.6)]))
    expect(detectSuspectedContradictions(memories, embeddings)).toHaveLength(
      CONTRADICTION_MAX_FINDINGS
    )
  })

  it(`considers only the ${CONTRADICTION_MAX_MEMORIES} coldest memories`, () => {
    // 60 warm near-duplicates (no pairs) plus two cold in-band rows: cold first.
    const cold = [mem({ id: "z-cold-1", accessCount: 0 }), mem({ id: "z-cold-2", accessCount: 0 })]
    const warm = Array.from({ length: CONTRADICTION_MAX_MEMORIES }, (_, i) =>
      mem({ id: `w${String(i).padStart(2, "0")}`, accessCount: 5 })
    )
    const embeddings = new Map<string, number[]>([
      ["z-cold-1", [1, 0]],
      ["z-cold-2", withSim(0.6)],
      ...warm.map((m) => [m.id, [0, 1]] as [string, number[]]),
    ])
    // z-cold-2 vs warm: sim(withSim(0.6), [0,1]) = 0.8 → out of band; z-cold-1 vs warm = 0.
    const out = detectSuspectedContradictions([...warm, ...cold], embeddings)
    expect(out.map((f) => f.memoryIds.sort().join(","))).toEqual(["z-cold-1,z-cold-2"])

    // With 60 colder rows ahead of them, the two warm-ish rows fall off the list.
    const colder = Array.from({ length: CONTRADICTION_MAX_MEMORIES }, (_, i) =>
      mem({ id: `c${String(i).padStart(2, "0")}`, accessCount: 0 })
    )
    const lukewarm = [mem({ id: "l1", accessCount: 9 }), mem({ id: "l2", accessCount: 9 })]
    const embeddings2 = new Map<string, number[]>([
      ["l1", [1, 0]],
      ["l2", withSim(0.6)],
      ...colder.map((m) => [m.id, [0, 1]] as [string, number[]]),
    ])
    expect(detectSuspectedContradictions([...lukewarm, ...colder], embeddings2)).toEqual([])
  })
})
