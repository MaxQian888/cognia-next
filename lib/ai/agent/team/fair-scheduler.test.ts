import { createFairTeamScheduler } from "./fair-scheduler"

describe("fair AgentTeam scheduler", () => {
  it("honors team quotas before raw priority", () => {
    const scheduler = createFairTeamScheduler({ globalConcurrency: 2, agingIntervalMs: 100 })
    scheduler.enqueue({ id: "a1", teamId: "a", priority: 10, enqueuedAt: 0, teamConcurrency: 1 })
    scheduler.enqueue({ id: "a2", teamId: "a", priority: 9, enqueuedAt: 0, teamConcurrency: 1 })
    scheduler.enqueue({ id: "b1", teamId: "b", priority: 1, enqueuedAt: 0, teamConcurrency: 1 })

    expect(scheduler.acquire(0)?.id).toBe("a1")
    expect(scheduler.acquire(0)?.id).toBe("b1")
    expect(scheduler.acquire(0)).toBeNull()

    scheduler.release("a1")
    expect(scheduler.acquire(0)?.id).toBe("a2")
  })

  it("ages old work so it cannot starve", () => {
    const scheduler = createFairTeamScheduler({ globalConcurrency: 1, agingIntervalMs: 100 })
    scheduler.enqueue({ id: "old", teamId: "a", priority: 0, enqueuedAt: 0, teamConcurrency: 1 })
    scheduler.enqueue({ id: "new", teamId: "b", priority: 5, enqueuedAt: 900, teamConcurrency: 1 })

    expect(scheduler.acquire(1_000)?.id).toBe("old")
  })

  it("never preempts an active child", () => {
    const scheduler = createFairTeamScheduler({ globalConcurrency: 1, agingIntervalMs: 100 })
    scheduler.enqueue({
      id: "running",
      teamId: "a",
      priority: 1,
      enqueuedAt: 0,
      teamConcurrency: 1,
    })
    expect(scheduler.acquire(0)?.id).toBe("running")
    scheduler.enqueue({
      id: "urgent",
      teamId: "b",
      priority: 100,
      enqueuedAt: 1,
      teamConcurrency: 1,
    })

    expect(scheduler.acquire(1)).toBeNull()
    scheduler.release("running")
    expect(scheduler.acquire(1)?.id).toBe("urgent")
  })
})
