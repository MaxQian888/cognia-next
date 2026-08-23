import { changesAreComplete, projectRunDetail } from "./run-detail-model"
import type { RunEvent, RunProjectionSnapshot } from "@/types/execution/run"

let seq = 0
function event(type: RunEvent["type"], payload: Record<string, unknown>): RunEvent {
  seq += 1
  return {
    id: `e${seq}`,
    runId: "run-1",
    seq,
    ts: seq,
    type,
    visibility: "private",
    payload,
  }
}

function snapshot(over: Partial<RunProjectionSnapshot> = {}): RunProjectionSnapshot {
  return {
    runId: "run-1",
    kind: "agent-turn",
    title: "Chat run",
    status: "running",
    revision: 1,
    startedAt: 1,
    updatedAt: 2,
    progress: { completed: 0, total: 0, trustworthy: false },
    activeSteps: [],
    recentSteps: [],
    pendingSteps: [],
    pendingStepCount: 0,
    elapsedMs: 1,
    artifacts: [],
    allowedActions: [],
    ...over,
  }
}

beforeEach(() => {
  seq = 0
})

describe("projectRunDetail", () => {
  it("splits verification artifacts out of the generic artifact list", () => {
    const detail = projectRunDetail(
      snapshot({
        artifacts: [
          { id: "a1", title: "Report" },
          {
            id: "a2",
            title: "Tests",
            kind: "verification",
            verification: {
              conclusion: "failed",
              passed: 3,
              failed: 1,
              skipped: 0,
              total: 4,
            },
          },
        ],
      }),
      []
    )
    expect(detail.artifacts.map((a) => a.id)).toEqual(["a1"])
    expect(detail.verifications.map((a) => a.id)).toEqual(["a2"])
    expect(detail.verifications[0].verification.failed).toBe(1)
  })

  /**
   * An artifact tagged `verification` with no counts is not a test result —
   * treating it as one would render an all-zero "0 failed" green row.
   */
  it("does not treat a verification-kind artifact with no counts as a test result", () => {
    const detail = projectRunDetail(
      snapshot({ artifacts: [{ id: "a3", title: "Tests", kind: "verification" }] }),
      []
    )
    expect(detail.verifications).toHaveLength(0)
    expect(detail.artifacts.map((a) => a.id)).toEqual(["a3"])
  })

  it("reads changed paths off the private journal events", () => {
    const detail = projectRunDetail(snapshot(), [
      event("resource.changed", { path: "src/a.ts", kind: "modified", sensitive: false }),
      event("resource.changed", { path: "src/b.ts", kind: "created", sensitive: false }),
    ])
    expect(detail.changes.map((c) => c.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(detail.changes[1].changeKind).toBe("created")
  })

  /** The connector runtime writes a pathless `resource.changed` recovery marker. */
  it("ignores a resource.changed event that names no path", () => {
    const detail = projectRunDetail(snapshot(), [
      event("resource.changed", { resourceId: "sdk-session:s1", recoveryAnchor: {} }),
    ])
    expect(detail.changes).toEqual([])
  })

  it("collapses repeated writes to one file, keeping the latest state", () => {
    const detail = projectRunDetail(snapshot(), [
      event("resource.changed", { path: "src/a.ts", kind: "created" }),
      event("resource.changed", { path: "src/a.ts", kind: "modified" }),
      event("resource.changed", { path: "src/a.ts", kind: "deleted" }),
    ])
    expect(detail.changes).toHaveLength(1)
    expect(detail.changes[0].changeKind).toBe("deleted")
  })

  it("keeps a sensitive file visible and flags it, rather than hiding the change", () => {
    const detail = projectRunDetail(snapshot(), [
      event("resource.changed", { path: ".env", kind: "modified", sensitive: true }),
    ])
    expect(detail.changes[0]).toMatchObject({ path: ".env", sensitive: true })
  })

  it("carries the overflow tally through instead of dropping it", () => {
    const detail = projectRunDetail(snapshot(), [
      event("resource.summary", {
        counts: { created: 1, modified: 2, bogus: "no" },
        eventCount: 3,
        overflowCount: 5,
        completeness: "resyncRequired",
      }),
    ])
    expect(detail.changeSummary).toEqual({
      counts: { created: 1, modified: 2 },
      eventCount: 3,
      overflowCount: 5,
      completeness: "resyncRequired",
    })
  })

  it("surfaces the activity window's omission count", () => {
    const detail = projectRunDetail(snapshot({ omittedActivityCount: 12 }), [])
    expect(detail.omittedActivityCount).toBe(12)
  })

  it("returns empty views for a run with no snapshot yet", () => {
    const detail = projectRunDetail(undefined, [])
    expect(detail).toMatchObject({
      activities: [],
      artifacts: [],
      verifications: [],
      changes: [],
      omittedActivityCount: 0,
    })
  })
})

describe("changesAreComplete", () => {
  it("is false when anything overflowed", () => {
    expect(
      changesAreComplete({ counts: {}, eventCount: 1, overflowCount: 1, completeness: "complete" })
    ).toBe(false)
  })

  it("is false for a timeline that needed a resync or a reconcile", () => {
    expect(
      changesAreComplete({
        counts: {},
        eventCount: 1,
        overflowCount: 0,
        completeness: "resyncRequired",
      })
    ).toBe(false)
    expect(
      changesAreComplete({
        counts: {},
        eventCount: 1,
        overflowCount: 0,
        completeness: "reconciled",
      })
    ).toBe(false)
  })

  it("is true when the producer reported a complete capture", () => {
    expect(
      changesAreComplete({ counts: {}, eventCount: 2, overflowCount: 0, completeness: "complete" })
    ).toBe(true)
  })
})
