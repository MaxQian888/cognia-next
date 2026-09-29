import type { Memory } from "@/types/memory/memory"
import {
  MAX_SWEEP_CANDIDATES,
  retentionParamsFor,
  runMemoryLifecycleSweep,
  type LifecycleSweepDeps,
  type LifecycleSweepInput,
} from "./lifecycle-sweep"

const DAY = 24 * 60 * 60 * 1000
const NOW = 2_000 * DAY

/**
 * An episodic row `ageDays` old that was never recalled: its retention is
 * e^(−0.02 · ageDays), so ≥ 81 days is below the default 0.2 threshold.
 */
function mem(id: string, ageDays: number, over: Partial<Memory> = {}): Memory {
  const createdAt = NOW - ageDays * DAY
  return {
    id,
    scope: "global",
    type: "episodic",
    text: "Went for a walk.",
    tags: [],
    importance: 5,
    createdAt,
    updatedAt: createdAt,
    lastAccessedAt: createdAt,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

/** Long enough that the summary + retained tokens is shorter than the original. */
const LONG_TEXT =
  "Fixed the flaky build in the release pipeline.\n\n" +
  "We spent most of the afternoon chasing the failure across several machines, " +
  "comparing logs line by line and rerunning the whole suite many times before " +
  "noticing that the cache directory was shared between parallel jobs."

function makeDeps(
  rows: Memory[],
  embeddings?: Map<string, number[]> | (() => Promise<Map<string, number[]>>)
) {
  const calls: string[] = []
  const deps = {
    listActive: jest.fn(async () => rows),
    reviseText: jest.fn(
      async (memory: Memory, _text: string, reason: "compaction" | "dedup-merge", _now: number) => {
        calls.push(`revise:${reason}:${memory.id}`)
      }
    ),
    supersede: jest.fn(async (loser: Memory, survivor: Memory) => {
      calls.push(`supersede:${loser.id}->${survivor.id}`)
    }),
    moveEvidence: jest.fn(async (loser: Memory, survivor: Memory) => {
      calls.push(`evidence:${loser.id}->${survivor.id}`)
    }),
    audit: jest.fn(async (event: Parameters<LifecycleSweepDeps["audit"]>[0]) => {
      calls.push(`audit:${event.reason}:${event.memoryId}`)
    }),
    ...(embeddings === undefined
      ? {}
      : {
          loadEmbeddings: jest.fn(
            typeof embeddings === "function" ? embeddings : async () => embeddings
          ),
        }),
  } satisfies LifecycleSweepDeps
  return { deps, calls }
}

function config(over: Partial<LifecycleSweepInput["config"]> = {}): LifecycleSweepInput["config"] {
  return {
    compactColdEpisodic: false,
    dedupColdClusters: false,
    coldRetentionThreshold: 0.2,
    accessReinforcementWeight: 0.6,
    ...over,
  }
}

describe("retentionParamsFor", () => {
  it("returns no override when the weight is unset", () => {
    expect(retentionParamsFor({})).toEqual({})
  })

  it("maps the weight to sigma and clamps negatives to zero", () => {
    expect(retentionParamsFor({ accessReinforcementWeight: 1.2 })).toEqual({ sigma: 1.2 })
    expect(retentionParamsFor({ accessReinforcementWeight: 0 })).toEqual({ sigma: 0 })
    expect(retentionParamsFor({ accessReinforcementWeight: -3 })).toEqual({ sigma: 0 })
  })
})

describe("runMemoryLifecycleSweep", () => {
  it("does no work at all when both passes are off", async () => {
    const { deps } = makeDeps([mem("a", 500, { text: LONG_TEXT })], new Map())
    const report = await runMemoryLifecycleSweep({ config: config(), now: NOW }, deps)
    expect(report).toEqual({ candidates: 0, compacted: [], merges: [] })
    expect(deps.listActive).not.toHaveBeenCalled()
    expect(deps.loadEmbeddings).not.toHaveBeenCalled()
    expect(deps.reviseText).not.toHaveBeenCalled()
  })

  describe("cold selection", () => {
    it("only takes decayable, uncompacted rows below the threshold", async () => {
      const rows = [
        mem("cold", 200, { text: LONG_TEXT }),
        mem("warm", 10, { text: LONG_TEXT }),
        mem("semantic", 200, { text: LONG_TEXT, type: "semantic" }),
        mem("procedural", 200, { text: LONG_TEXT, type: "procedural" }),
        mem("pinned", 200, { text: LONG_TEXT, pinned: true }),
        mem("claim", 200, { text: LONG_TEXT, projectMemoryKind: "constraint" } as Partial<Memory>),
        mem("compacted", 200, { text: LONG_TEXT, compactedAt: NOW - DAY }),
        mem("forgotten", 200, { text: LONG_TEXT, status: "invalidated" }),
      ]
      const { deps } = makeDeps(rows)
      const report = await runMemoryLifecycleSweep(
        { config: config({ compactColdEpisodic: true }), now: NOW },
        deps
      )
      expect(report.candidates).toBe(1)
      expect(report.compacted).toEqual(["cold"])
    })

    it("honours a custom threshold", async () => {
      // 50 days ⇒ retention ≈ 0.37: warm at 0.2, cold at 0.5.
      const rows = [mem("mid", 50, { text: LONG_TEXT })]
      const low = makeDeps(rows)
      expect(
        (
          await runMemoryLifecycleSweep(
            { config: config({ compactColdEpisodic: true }), now: NOW },
            low.deps
          )
        ).candidates
      ).toBe(0)
      const high = makeDeps(rows)
      const report = await runMemoryLifecycleSweep(
        { config: config({ compactColdEpisodic: true, coldRetentionThreshold: 0.5 }), now: NOW },
        high.deps
      )
      expect(report.compacted).toEqual(["mid"])
    })

    it("counts recall through the configured reinforcement weight", async () => {
      // 200 days old but recalled 20 times yesterday: warm with σ = 0.6,
      // cold again once reinforcement is switched off.
      const recalled = mem("recalled", 200, {
        text: LONG_TEXT,
        accessCount: 20,
        lastAccessedAt: NOW - DAY,
      })
      const on = makeDeps([recalled])
      expect(
        (
          await runMemoryLifecycleSweep(
            { config: config({ compactColdEpisodic: true }), now: NOW },
            on.deps
          )
        ).candidates
      ).toBe(0)
      const off = makeDeps([recalled])
      const report = await runMemoryLifecycleSweep(
        {
          config: config({ compactColdEpisodic: true, accessReinforcementWeight: 0 }),
          now: NOW,
        },
        off.deps
      )
      expect(report.compacted).toEqual(["recalled"])
    })

    it("processes coldest first and caps the run", async () => {
      const rows = Array.from({ length: MAX_SWEEP_CANDIDATES + 5 }, (_, i) =>
        // i = 0 is the warmest cold row, the last is the coldest.
        mem(`m${i}`, 100 + i, { text: LONG_TEXT })
      )
      const { deps } = makeDeps(rows)
      const report = await runMemoryLifecycleSweep(
        { config: config({ compactColdEpisodic: true }), now: NOW },
        deps
      )
      expect(report.candidates).toBe(MAX_SWEEP_CANDIDATES)
      expect(report.compacted).toHaveLength(MAX_SWEEP_CANDIDATES)
      expect(report.compacted[0]).toBe(`m${MAX_SWEEP_CANDIDATES + 4}`)
      expect(report.compacted.at(-1)).toBe("m5")
      // The five warmest cold rows wait for the next run.
      for (let i = 0; i < 5; i++) expect(report.compacted).not.toContain(`m${i}`)
    })

    it("returns early without loading vectors when nothing is cold", async () => {
      const { deps } = makeDeps([mem("warm", 5)], new Map())
      const report = await runMemoryLifecycleSweep(
        { config: config({ compactColdEpisodic: true, dedupColdClusters: true }), now: NOW },
        deps
      )
      expect(report).toEqual({ candidates: 0, compacted: [], merges: [] })
      expect(deps.loadEmbeddings).not.toHaveBeenCalled()
    })
  })

  describe("dedup", () => {
    it("folds a cluster into its highest-retention member", async () => {
      const survivor = mem("survivor", 100, { text: "Deployed with `DEPLOY_TOKEN` set." })
      const loser = mem("loser", 300, { text: "Deployed after exporting `DEPLOY_REGION`." })
      const other = mem("other", 200, { text: "Unrelated cold episode." })
      const embeddings = new Map([
        ["survivor", [1, 0, 0]],
        ["loser", [1, 0, 0]],
        ["other", [0, 1, 0]],
      ])
      const { deps, calls } = makeDeps([survivor, loser, other], embeddings)
      const report = await runMemoryLifecycleSweep(
        { config: config({ dedupColdClusters: true }), now: NOW },
        deps
      )

      expect(report.merges).toEqual([{ survivorId: "survivor", mergedIds: ["loser"] }])
      expect(report.compacted).toEqual([])
      expect(report.dedupSkipped).toBeUndefined()
      expect(deps.loadEmbeddings).toHaveBeenCalledWith(
        expect.arrayContaining([survivor, loser, other])
      )
      const [revised, text, reason, at] = deps.reviseText.mock.calls[0]!
      expect(revised).toBe(survivor)
      expect(reason).toBe("dedup-merge")
      expect(at).toBe(NOW)
      // The survivor absorbs the duplicate's durable token.
      expect(text).toContain("DEPLOY_REGION")
      expect(deps.moveEvidence).toHaveBeenCalledWith(loser, survivor)
      expect(deps.supersede).toHaveBeenCalledWith(loser, survivor)
      expect(deps.audit).toHaveBeenCalledWith({
        action: "invalidated",
        memoryId: "loser",
        reason: "dedup_merged",
        metadata: { survivorId: "survivor" },
      })
      expect(deps.audit).toHaveBeenCalledWith({
        action: "revised",
        memoryId: "survivor",
        reason: "dedup_merge",
        metadata: { merged: 1 },
      })
      // Evidence moves before the loser is superseded, so nothing is orphaned.
      expect(calls).toEqual([
        "revise:dedup-merge:survivor",
        "evidence:loser->survivor",
        "supersede:loser->survivor",
        "audit:dedup_merged:loser",
        "audit:dedup_merge:survivor",
      ])
    })

    it("never merges across namespaces", async () => {
      const a = mem("a", 150, { scope: "workspace", projectId: "p1" })
      const b = mem("b", 160, { scope: "workspace", projectId: "p2" })
      const c = mem("c", 170, { scope: "character", characterId: "ch1" })
      const d = mem("d", 180, { scope: "workspace", projectId: "p1", branch: "feature" })
      const same = [1, 0, 0]
      const { deps } = makeDeps(
        [a, b, c, d],
        new Map([
          ["a", same],
          ["b", same],
          ["c", same],
          ["d", same],
        ])
      )
      const report = await runMemoryLifecycleSweep(
        { config: config({ dedupColdClusters: true }), now: NOW },
        deps
      )
      expect(report.merges).toEqual([])
      expect(deps.reviseText).not.toHaveBeenCalled()
      expect(deps.supersede).not.toHaveBeenCalled()
    })

    it("merges within one namespace while leaving the other alone", async () => {
      const p1a = mem("p1a", 100, { scope: "workspace", projectId: "p1" })
      const p1b = mem("p1b", 200, { scope: "workspace", projectId: "p1" })
      // A distinct third p1 row, so the namespace also holds a non-duplicate.
      const p1c = mem("p1c", 300, { scope: "workspace", projectId: "p1" })
      const p2 = mem("p2", 150, { scope: "workspace", projectId: "p2" })
      const same = [0, 0, 1]
      const { deps } = makeDeps(
        [p1a, p1b, p1c, p2],
        new Map([
          ["p1a", same],
          ["p1b", same],
          ["p1c", [1, 0, 0]],
          ["p2", same],
        ])
      )
      const report = await runMemoryLifecycleSweep(
        { config: config({ dedupColdClusters: true }), now: NOW },
        deps
      )
      expect(report.merges).toEqual([{ survivorId: "p1a", mergedIds: ["p1b"] }])
      expect(deps.supersede).toHaveBeenCalledTimes(1)
    })

    it("merges a namespace that holds exactly two duplicates", async () => {
      const a = mem("a", 100, { scope: "workspace", projectId: "p1" })
      const b = mem("b", 200, { scope: "workspace", projectId: "p1" })
      const { deps } = makeDeps(
        [a, b],
        new Map([
          ["a", [0, 0, 1]],
          ["b", [0, 0, 1]],
        ])
      )
      const report = await runMemoryLifecycleSweep(
        { config: config({ dedupColdClusters: true }), now: NOW },
        deps
      )
      expect(report.merges).toEqual([{ survivorId: "a", mergedIds: ["b"] }])
    })

    it("does not compact rows a dedup cluster claimed", async () => {
      const survivor = mem("survivor", 100, { text: LONG_TEXT })
      const loser = mem("loser", 110, { text: LONG_TEXT })
      const loner = mem("loner", 120, { text: LONG_TEXT })
      const { deps } = makeDeps(
        [survivor, loser, loner],
        new Map([
          ["survivor", [1, 0]],
          ["loser", [1, 0]],
          ["loner", [0, 1]],
        ])
      )
      const report = await runMemoryLifecycleSweep(
        { config: config({ dedupColdClusters: true, compactColdEpisodic: true }), now: NOW },
        deps
      )
      expect(report.merges).toEqual([{ survivorId: "survivor", mergedIds: ["loser"] }])
      expect(report.compacted).toEqual(["loner"])
      const compactions = deps.reviseText.mock.calls.filter((call) => call[2] === "compaction")
      expect(compactions.map((call) => call[0].id)).toEqual(["loner"])
    })

    it("skips dedup with no_vectors when no loader is wired", async () => {
      const { deps } = makeDeps([mem("a", 200, { text: LONG_TEXT })])
      const report = await runMemoryLifecycleSweep(
        { config: config({ dedupColdClusters: true, compactColdEpisodic: true }), now: NOW },
        deps
      )
      expect(report.dedupSkipped).toBe("no_vectors")
      // Compaction still runs.
      expect(report.compacted).toEqual(["a"])
    })

    it("skips dedup with no_vectors when the loader returns nothing", async () => {
      const { deps } = makeDeps([mem("a", 200), mem("b", 210)], new Map())
      const report = await runMemoryLifecycleSweep(
        { config: config({ dedupColdClusters: true }), now: NOW },
        deps
      )
      expect(report.dedupSkipped).toBe("no_vectors")
      expect(report.merges).toEqual([])
    })

    it("skips dedup with no_vectors when the loader throws", async () => {
      const { deps } = makeDeps([mem("a", 200), mem("b", 210)], async () => {
        throw new Error("vector backend down")
      })
      const report = await runMemoryLifecycleSweep(
        { config: config({ dedupColdClusters: true }), now: NOW },
        deps
      )
      expect(report.dedupSkipped).toBe("no_vectors")
      expect(deps.reviseText).not.toHaveBeenCalled()
    })

    it("ignores rows that have no vector", async () => {
      const { deps } = makeDeps([mem("a", 200), mem("b", 210)], new Map([["a", [1, 0]]]))
      const report = await runMemoryLifecycleSweep(
        { config: config({ dedupColdClusters: true }), now: NOW },
        deps
      )
      expect(report.dedupSkipped).toBeUndefined()
      expect(report.merges).toEqual([])
    })
  })

  describe("compaction", () => {
    it("replaces a long cold row with its summary and audits it", async () => {
      const row = mem("long", 200, { text: LONG_TEXT })
      const { deps, calls } = makeDeps([row])
      const report = await runMemoryLifecycleSweep(
        { config: config({ compactColdEpisodic: true }), now: NOW },
        deps
      )
      expect(report).toEqual({ candidates: 1, compacted: ["long"], merges: [] })
      const [revised, text, reason, at] = deps.reviseText.mock.calls[0]!
      expect(revised).toBe(row)
      expect(reason).toBe("compaction")
      expect(at).toBe(NOW)
      expect(text).toBe("Fixed the flaky build in the release pipeline.")
      expect(text.length).toBeLessThan(LONG_TEXT.length)
      expect(deps.audit).toHaveBeenCalledWith({
        action: "revised",
        memoryId: "long",
        reason: "compacted",
        metadata: { keepTokens: 0 },
      })
      expect(calls).toEqual(["revise:compaction:long", "audit:compacted:long"])
    })

    it("records how many durable tokens were retained", async () => {
      const text =
        "Build broke on CI.\n\n" +
        "The failure came from packages/core/src/index.ts where `resolveConfig` " +
        "threw E0433 until MAX_RETRIES was raised; a lot of unrelated narration follows here."
      const { deps } = makeDeps([mem("tokens", 200, { text })])
      await runMemoryLifecycleSweep(
        { config: config({ compactColdEpisodic: true }), now: NOW },
        deps
      )
      const [, compacted] = deps.reviseText.mock.calls[0]!
      expect(compacted).toContain("Retained facts:")
      expect(compacted).toContain("packages/core/src/index.ts")
      const audit = deps.audit.mock.calls[0]![0]
      expect(audit.reason).toBe("compacted")
      expect(Number(audit.metadata?.keepTokens)).toBeGreaterThan(0)
    })

    it("leaves a row too short to shrink untouched", async () => {
      const { deps } = makeDeps([mem("short", 200, { text: "Went for a walk." })])
      const report = await runMemoryLifecycleSweep(
        { config: config({ compactColdEpisodic: true }), now: NOW },
        deps
      )
      expect(report).toEqual({ candidates: 1, compacted: [], merges: [] })
      expect(deps.reviseText).not.toHaveBeenCalled()
      expect(deps.audit).not.toHaveBeenCalled()
    })

    it("does not compact when only dedup is on", async () => {
      const { deps } = makeDeps([mem("long", 200, { text: LONG_TEXT })], new Map([["long", [1]]]))
      const report = await runMemoryLifecycleSweep(
        { config: config({ dedupColdClusters: true }), now: NOW },
        deps
      )
      expect(report.candidates).toBe(1)
      expect(report.compacted).toEqual([])
      expect(deps.reviseText).not.toHaveBeenCalled()
    })

    it("uses the real clock when no now is injected", async () => {
      const row = mem("long", 0, { text: LONG_TEXT, createdAt: 0, lastAccessedAt: 0, updatedAt: 0 })
      const { deps } = makeDeps([row])
      const before = Date.now()
      await runMemoryLifecycleSweep({ config: config({ compactColdEpisodic: true }) }, deps)
      expect(deps.reviseText.mock.calls[0]![3]).toBeGreaterThanOrEqual(before)
    })
  })
})
