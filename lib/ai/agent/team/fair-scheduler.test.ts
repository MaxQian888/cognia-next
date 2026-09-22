import { createFairTeamScheduler } from "./fair-scheduler"

describe("fair AgentTeam scheduler", () => {
  it.each([NaN, Infinity, 0, -1, 1.5])("rejects invalid concurrency %s", (limit) => {
    expect(() =>
      createFairTeamScheduler({ globalConcurrency: limit, agingIntervalMs: 100 })
    ).toThrow()
    const scheduler = createFairTeamScheduler({ globalConcurrency: 1, agingIntervalMs: 100 })
    expect(() =>
      scheduler.enqueue({
        id: "x",
        teamId: "a",
        priority: 0,
        enqueuedAt: 0,
        teamConcurrency: limit,
      })
    ).toThrow()
  })

  it("keeps queued and active reservations private from caller mutation", () => {
    const scheduler = createFairTeamScheduler({ globalConcurrency: 2, agingIntervalMs: 100 })
    const first = { id: "a1", teamId: "a", priority: 1, enqueuedAt: 0, teamConcurrency: 1 }
    scheduler.enqueue(first)
    first.teamId = "different"
    scheduler.snapshot().queued[0]!.teamConcurrency = 100
    scheduler.enqueue({ id: "a2", teamId: "a", priority: 0, enqueuedAt: 0, teamConcurrency: 1 })
    const acquired = scheduler.acquire(0)!
    acquired.teamId = "different"
    scheduler.snapshot().active[0]!.teamId = "different"
    expect(scheduler.acquire(0)).toBeNull()
    expect(scheduler.release("a1")).toBe(true)
    expect(scheduler.acquire(0)?.id).toBe("a2")
  })

  it("drains a large mixed queue without exceeding quotas or admitting cancelled jobs", () => {
    const scheduler = createFairTeamScheduler({ globalConcurrency: 8, agingIntervalMs: 10 })
    const expected = new Set<string>()
    for (let index = 0; index < 2000; index += 1) {
      const id = `job-${index}`
      scheduler.enqueue({
        id,
        teamId: `team-${index % 7}`,
        priority: index % 5,
        enqueuedAt: index,
        teamConcurrency: 2,
      })
      if (index % 11 === 0) scheduler.cancel(id)
      else expected.add(id)
    }
    const seen = new Set<string>()
    while (seen.size < expected.size) {
      let job = scheduler.acquire(3000)
      while (job) {
        expect(seen.has(job.id)).toBe(false)
        seen.add(job.id)
        const active = scheduler.snapshot().active
        expect(active.length).toBeLessThanOrEqual(8)
        expect(active.filter((item) => item.teamId === job!.teamId).length).toBeLessThanOrEqual(2)
        job = scheduler.acquire(3000)
      }
      for (const active of scheduler.snapshot().active) scheduler.release(active.id)
    }
    expect(seen).toEqual(expected)
    expect(scheduler.snapshot()).toEqual({ queued: [], active: [] })
  })
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
