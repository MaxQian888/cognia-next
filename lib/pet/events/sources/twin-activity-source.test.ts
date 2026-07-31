import {
  deriveBusy,
  isMilestoneJob,
  newestMilestone,
  wireTwinActivitySource,
} from "./twin-activity-source"
import type { RowObserver } from "./goal-source"
import type { TwinJob } from "@/types/twin"
import type { PetEvent } from "@/types/pet"

function job(overrides: Partial<TwinJob> = {}): TwinJob {
  return {
    id: "twj_1",
    twinId: "tw_1",
    kind: "distill",
    sourceIds: [],
    status: "completed",
    phase: "completed",
    progress: 100,
    queuedAt: 0,
    retryCount: 0,
    ...overrides,
  }
}

describe("deriveBusy", () => {
  it("is busy for any positive active-job count, else idle", () => {
    expect(deriveBusy(0)).toBe(false)
    expect(deriveBusy(1)).toBe(true)
    expect(deriveBusy(5)).toBe(true)
  })
})

describe("isMilestoneJob", () => {
  it("qualifies completed distill/re-distill jobs only", () => {
    expect(isMilestoneJob(job({ kind: "distill", status: "completed" }))).toBe(true)
    expect(isMilestoneJob(job({ kind: "re-distill", status: "completed" }))).toBe(true)
    expect(isMilestoneJob(job({ kind: "ingest", status: "completed" }))).toBe(false)
    expect(isMilestoneJob(job({ kind: "distill", status: "running" }))).toBe(false)
  })
})

describe("newestMilestone", () => {
  it("picks the milestone with the latest completedAt, ignoring non-milestones", () => {
    const jobs = [
      job({ id: "a", completedAt: 100 }),
      job({ id: "b", completedAt: 300 }),
      job({ id: "c", kind: "ingest", completedAt: 900 }), // not a milestone → ignored
      job({ id: "d", completedAt: 200 }),
    ]
    expect(newestMilestone(jobs)?.id).toBe("b")
  })

  it("returns null when there are no milestone jobs", () => {
    expect(newestMilestone([job({ kind: "ingest" })])).toBeNull()
    expect(newestMilestone([])).toBeNull()
  })
})

describe("wireTwinActivitySource", () => {
  function setup() {
    let pushActive: (rows: TwinJob[]) => void = () => {}
    let pushCompleted: (rows: TwinJob[]) => void = () => {}
    const disposeActive = jest.fn()
    const disposeCompleted = jest.fn()
    const observeActive: RowObserver<TwinJob> = (onRows) => {
      pushActive = onRows
      return disposeActive
    }
    const observeCompleted: RowObserver<TwinJob> = (onRows) => {
      pushCompleted = onRows
      return disposeCompleted
    }
    const events: PetEvent[] = []
    const dispose = wireTwinActivitySource("tw_1", { observeActive, observeCompleted })((e) =>
      events.push({ ...e, at: 0 })
    )
    return {
      pushActive: (rows: TwinJob[]) => pushActive(rows),
      pushCompleted: (rows: TwinJob[]) => pushCompleted(rows),
      dispose,
      disposeActive,
      disposeCompleted,
      events,
    }
  }

  it("emits twinBusy immediately when a job is already active at mount (no suppression)", () => {
    const { pushActive, events } = setup()
    pushActive([job({ status: "running" })])
    expect(events).toEqual([
      expect.objectContaining({
        source: "twin",
        kind: "twinBusy",
        meta: { twinId: "tw_1", activeJobCount: 1 },
      }),
    ])
  })

  it("emits idle on the busy→not-busy edge, and ignores repeated same-state ticks", () => {
    const { pushActive, events } = setup()
    pushActive([job({ status: "running" })]) // → twinBusy
    pushActive([job({ status: "running" }), job({ id: "x", status: "queued" })]) // still busy → no re-emit
    pushActive([]) // → idle
    pushActive([]) // still idle → no re-emit
    expect(events.map((e) => e.kind)).toEqual(["twinBusy", "idle"])
    expect(events[1]).toMatchObject({ source: "twin", meta: { twinId: "tw_1" } })
  })

  it("suppresses the pre-existing newest milestone, then emits on a fresh one", () => {
    const { pushCompleted, events } = setup()
    pushCompleted([job({ id: "old", completedAt: 100 })]) // pre-existing → suppressed
    pushCompleted([job({ id: "old", completedAt: 100 })]) // unchanged → ignored
    pushCompleted([job({ id: "new", completedAt: 200, kind: "re-distill" })]) // → twinMilestone
    expect(events.map((e) => e.kind)).toEqual(["twinMilestone"])
    expect(events[0]).toMatchObject({
      source: "twin",
      meta: { twinId: "tw_1", jobKind: "re-distill" },
    })
  })

  it("ignores completed rows with no milestone-qualifying job", () => {
    const { pushCompleted, events } = setup()
    pushCompleted([job({ kind: "ingest" })])
    pushCompleted([])
    expect(events).toHaveLength(0)
  })

  it("dispose tears down both observers", () => {
    const { dispose, disposeActive, disposeCompleted } = setup()
    dispose()
    expect(disposeActive).toHaveBeenCalledTimes(1)
    expect(disposeCompleted).toHaveBeenCalledTimes(1)
  })
})
