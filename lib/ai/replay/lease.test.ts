import { AmbiguousReplayTapesError, createReplayLedger, formatConsumptionReport } from "./lease"
import type { ReplayTapeV1 } from "@cognia/agent-config-types/model-request-surface"

const DIGEST_A = `sha256:${"a".repeat(64)}`
const DIGEST_B = `sha256:${"b".repeat(64)}`

function tape(overrides: Partial<ReplayTapeV1> = {}): ReplayTapeV1 {
  return {
    schemaVersion: 1,
    tapeId: "tape-1",
    match: { actorRef: "root", purpose: "turn", requestDigest: DIGEST_A },
    behavior: { kind: "stream", chunksRef: "asset-1" },
    synthetic: true,
    ...overrides,
  }
}

describe("matching", () => {
  it("serves a tape whose purpose and digest both match", () => {
    const ledger = createReplayLedger([tape()])
    const found = ledger.lease("root").take({ purpose: "turn", requestDigest: DIGEST_A })
    expect(found?.tapeId).toBe("tape-1")
  })

  it("consumes a tape only once", () => {
    const ledger = createReplayLedger([tape()])
    const lease = ledger.lease("root")
    expect(lease.take({ purpose: "turn", requestDigest: DIGEST_A })).toBeDefined()
    expect(lease.take({ purpose: "turn", requestDigest: DIGEST_A })).toBeUndefined()
  })

  it("serves a repeated question from two identical tapes", () => {
    const ledger = createReplayLedger([tape({ tapeId: "a" }), tape({ tapeId: "b" })])
    const lease = ledger.lease("root")
    expect(lease.take({ purpose: "turn", requestDigest: DIGEST_A })).toBeDefined()
    expect(lease.take({ purpose: "turn", requestDigest: DIGEST_A })).toBeDefined()
    expect(lease.take({ purpose: "turn", requestDigest: DIGEST_A })).toBeUndefined()
  })

  it("does not match across purposes", () => {
    const ledger = createReplayLedger([tape()])
    expect(ledger.lease("root").take({ purpose: "title", requestDigest: DIGEST_A })).toBeUndefined()
  })

  it("does not match a different digest", () => {
    const ledger = createReplayLedger([tape()])
    expect(ledger.lease("root").take({ purpose: "turn", requestDigest: DIGEST_B })).toBeUndefined()
  })

  it("keeps actors from consuming each other's tapes", () => {
    // The whole reason leases exist: two children asking the same question must
    // each get their own recording, whatever order they interleave in.
    const ledger = createReplayLedger([
      tape({
        tapeId: "for-a",
        match: { actorRef: "child-a", purpose: "turn", requestDigest: DIGEST_A },
      }),
      tape({
        tapeId: "for-b",
        match: { actorRef: "child-b", purpose: "turn", requestDigest: DIGEST_A },
      }),
    ])
    const b = ledger.lease("child-b")
    const a = ledger.lease("child-a")
    expect(b.take({ purpose: "turn", requestDigest: DIGEST_A })?.tapeId).toBe("for-b")
    expect(a.take({ purpose: "turn", requestDigest: DIGEST_A })?.tapeId).toBe("for-a")
  })

  it("is insensitive to the order requests arrive in", () => {
    const ledger = createReplayLedger([
      tape({ tapeId: "first" }),
      tape({
        tapeId: "second",
        match: { actorRef: "root", purpose: "title", requestDigest: DIGEST_B },
      }),
    ])
    const lease = ledger.lease("root")
    expect(lease.take({ purpose: "title", requestDigest: DIGEST_B })?.tapeId).toBe("second")
    expect(lease.take({ purpose: "turn", requestDigest: DIGEST_A })?.tapeId).toBe("first")
    expect(ledger.assertConsumed().ok).toBe(true)
  })

  it("returns an unknown actor an empty lease rather than throwing", () => {
    const ledger = createReplayLedger([tape()])
    expect(ledger.lease("ghost").take({ purpose: "turn", requestDigest: DIGEST_A })).toBeUndefined()
    expect(ledger.lease("ghost").remaining()).toEqual([])
  })

  it("reuses one lease per actor so a resume cannot re-consume", () => {
    const ledger = createReplayLedger([tape()])
    ledger.lease("root").take({ purpose: "turn", requestDigest: DIGEST_A })
    // Same actor resumed after an interrupt: the lease is the same object and
    // its consumed set survives.
    expect(ledger.lease("root").take({ purpose: "turn", requestDigest: DIGEST_A })).toBeUndefined()
  })

  it("reports what an actor still holds", () => {
    const ledger = createReplayLedger([tape({ tapeId: "x" }), tape({ tapeId: "y" })])
    const lease = ledger.lease("root")
    lease.take({ purpose: "turn", requestDigest: DIGEST_A })
    expect(lease.remaining().map((entry) => entry.tapeId)).toEqual(["y"])
  })
})

describe("ambiguity", () => {
  it("refuses a tape set that cannot be matched deterministically", () => {
    expect(() =>
      createReplayLedger([
        tape({ tapeId: "a" }),
        tape({ tapeId: "b", behavior: { kind: "error", code: "overloaded", message: "busy" } }),
      ])
    ).toThrow(AmbiguousReplayTapesError)
  })

  it("fails before any request is answered", () => {
    // Discovering this mid-run would leave half-executed side effects behind.
    try {
      createReplayLedger([
        tape({ tapeId: "a" }),
        tape({ tapeId: "b", behavior: { kind: "cancel" } }),
      ])
      throw new Error("expected AmbiguousReplayTapesError")
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousReplayTapesError)
      expect((error as AmbiguousReplayTapesError).keys).toHaveLength(1)
    }
  })

  it("accepts an empty tape set", () => {
    expect(createReplayLedger([]).assertConsumed().ok).toBe(true)
  })
})

describe("assertConsumed", () => {
  it("passes when every tape was used and nothing is open", () => {
    const ledger = createReplayLedger([tape()])
    ledger.lease("root").take({ purpose: "turn", requestDigest: DIGEST_A })
    expect(ledger.assertConsumed()).toEqual({ ok: true, problems: [] })
  })

  it("reports a recorded request that never arrived", () => {
    const ledger = createReplayLedger([tape()])
    const report = ledger.assertConsumed()
    expect(report.ok).toBe(false)
    expect(report.problems).toEqual([
      {
        kind: "unconsumed-tape",
        actorRef: "root",
        detail: "tape-1 (turn) was recorded but never requested",
      },
    ])
  })

  it("reports a request that had no tape", () => {
    const ledger = createReplayLedger([])
    ledger.lease("root").take({ purpose: "turn", requestDigest: DIGEST_A })
    const report = ledger.assertConsumed()
    expect(report.ok).toBe(false)
    expect(report.problems[0]).toEqual({
      kind: "unmatched-request",
      actorRef: "root",
      detail: `turn request ${DIGEST_A} had no tape`,
    })
  })

  it("reports both directions at once", () => {
    const ledger = createReplayLedger([tape()])
    ledger.lease("root").take({ purpose: "turn", requestDigest: DIGEST_B })
    const report = ledger.assertConsumed()
    expect(report.problems.map((problem) => problem.kind)).toEqual([
      "unconsumed-tape",
      "unmatched-request",
    ])
  })

  it("folds in the runner's own loose ends", () => {
    const report = createReplayLedger([]).assertConsumed({
      unconsumedPermissions: ["Bash was never asked for"],
      unfinishedChildren: ["child-a still running"],
      orphanedLogs: ["run-9 has no parent"],
    })
    expect(report.ok).toBe(false)
    expect(report.problems.map((problem) => problem.kind)).toEqual([
      "unconsumed-permission",
      "unfinished-child",
      "orphaned-log",
    ])
  })

  it("ignores empty loose-end lists", () => {
    const report = createReplayLedger([]).assertConsumed({
      unconsumedPermissions: [],
      unfinishedChildren: [],
    })
    expect(report.ok).toBe(true)
  })
})

describe("formatConsumptionReport", () => {
  it("states success plainly", () => {
    expect(formatConsumptionReport({ ok: true, problems: [] })).toContain("consumed every tape")
  })

  it("lists each problem with its kind and actor", () => {
    const text = formatConsumptionReport({
      ok: false,
      problems: [
        { kind: "unconsumed-tape", actorRef: "root", detail: "tape-1 never requested" },
        { kind: "orphaned-log", detail: "run-9 has no parent" },
      ],
    })
    expect(text).toContain("2 problem(s)")
    expect(text).toContain("[unconsumed-tape] root: tape-1 never requested")
    expect(text).toContain("[orphaned-log] run-9 has no parent")
  })
})
