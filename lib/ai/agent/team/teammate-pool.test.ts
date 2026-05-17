import { createTeammatePool } from "./teammate-pool"
import type { AgentTeammate } from "@/types/agent/agent-team"

const tm = (id: string, name: string = id): AgentTeammate =>
  ({
    id,
    name,
    teamId: "team-1",
    description: "",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
  }) satisfies AgentTeammate

describe("TeammatePool (v1 baseline)", () => {
  it("returns null when initialized with no teammates", () => {
    const pool = createTeammatePool({ teammates: [] })
    expect(pool.claim("t1")).toBeNull()
    expect(pool.allUnavailable()).toBe(true)
  })

  it("round-robin selects teammates in order", () => {
    const a = tm("a")
    const b = tm("b")
    const pool = createTeammatePool({ teammates: [a, b] })
    expect(pool.claim("t1")?.id).toBe("a")
    expect(pool.claim("t2")?.id).toBe("b")
    expect(pool.claim("t3")?.id).toBe("a")
  })

  it("recordSuccess and recordFailure update the breaker without throwing", () => {
    const a = tm("a")
    const pool = createTeammatePool({ teammates: [a] })
    pool.recordSuccess("a")
    pool.recordFailure("a", new Error("boom"))
  })

  it("teammate becomes unavailable after enough failures", () => {
    const a = tm("a")
    const b = tm("b")
    const pool = createTeammatePool({
      teammates: [a, b],
      breakerOptions: { minEvents: 2, failureThresholdPct: 50, cooldownMs: 60_000 },
    })
    pool.recordFailure("a", new Error("e1"))
    expect(pool.availableCount()).toBe(2)
    pool.recordFailure("a", new Error("e2"))
    expect(pool.availableCount()).toBe(1)
  })

  it("claim skips quarantined teammates", () => {
    const a = tm("a")
    const b = tm("b")
    const pool = createTeammatePool({
      teammates: [a, b],
      breakerOptions: { minEvents: 2, failureThresholdPct: 50, cooldownMs: 60_000 },
    })
    pool.recordFailure("a", new Error("e1"))
    pool.recordFailure("a", new Error("e2"))
    expect(pool.claim("t1")?.id).toBe("b")
    expect(pool.claim("t2")?.id).toBe("b")
  })

  it("onAllUnavailable fires when last teammate is quarantined", () => {
    const a = tm("a")
    const fn = jest.fn()
    const pool = createTeammatePool({
      teammates: [a],
      breakerOptions: { minEvents: 2, failureThresholdPct: 50, cooldownMs: 60_000 },
    })
    pool.onAllUnavailable(fn)
    pool.recordFailure("a", new Error("e1"))
    expect(fn).not.toHaveBeenCalled()
    pool.recordFailure("a", new Error("e2"))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("onAllUnavailable is edge-triggered (does not re-fire on subsequent failures)", () => {
    const a = tm("a")
    const fn = jest.fn()
    const pool = createTeammatePool({
      teammates: [a],
      breakerOptions: { minEvents: 2, failureThresholdPct: 50, cooldownMs: 60_000 },
    })
    pool.onAllUnavailable(fn)
    pool.recordFailure("a", new Error("e1"))
    pool.recordFailure("a", new Error("e2"))
    pool.recordFailure("a", new Error("e3"))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("forceUnquarantine resets specific teammates", () => {
    const a = tm("a")
    const pool = createTeammatePool({
      teammates: [a],
      breakerOptions: { minEvents: 2, failureThresholdPct: 50, cooldownMs: 60_000 },
    })
    pool.recordFailure("a", new Error("e1"))
    pool.recordFailure("a", new Error("e2"))
    expect(pool.availableCount()).toBe(0)
    pool.forceUnquarantine({ teammateIds: ["a"] })
    expect(pool.availableCount()).toBe(1)
    expect(pool.claim("t1")?.id).toBe("a")
  })

  it("forceUnquarantine with resetAll=true resets all teammates", () => {
    const a = tm("a")
    const b = tm("b")
    const pool = createTeammatePool({
      teammates: [a, b],
      breakerOptions: { minEvents: 2, failureThresholdPct: 50, cooldownMs: 60_000 },
    })
    pool.recordFailure("a", new Error("e1"))
    pool.recordFailure("a", new Error("e2"))
    pool.recordFailure("b", new Error("e1"))
    pool.recordFailure("b", new Error("e2"))
    expect(pool.availableCount()).toBe(0)
    pool.forceUnquarantine({ resetAll: true })
    expect(pool.availableCount()).toBe(2)
  })

  it("unsubscribe stops onAllUnavailable callbacks", () => {
    const a = tm("a")
    const fn = jest.fn()
    const pool = createTeammatePool({
      teammates: [a],
      breakerOptions: { minEvents: 2, failureThresholdPct: 50, cooldownMs: 60_000 },
    })
    const unsub = pool.onAllUnavailable(fn)
    unsub()
    pool.recordFailure("a", new Error("e1"))
    pool.recordFailure("a", new Error("e2"))
    expect(fn).not.toHaveBeenCalled()
  })

  // PR 6 extensions — placeholders so the surface is visible from PR 2 onward.
  it.todo("PR 6: classifies 401 as catastrophic → disqualified")
  it.todo("PR 6: classifies 429 as rate_limited → immediate breaker open")
  it.todo("PR 6: rejoin clears disqualified")
  it.todo("PR 6: onTeammateDisqualified edge-triggered per teammate")
})
