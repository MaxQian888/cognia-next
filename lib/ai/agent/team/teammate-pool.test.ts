import { createTeammatePool } from "./teammate-pool"
import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import type { AgentTeammate } from "@/types/agent/agent-team"

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginLifecycleHooks: jest.fn(),
}))

const dispatchOnTeammateClaim = jest.fn()
const dispatchOnTeammateRelease = jest.fn()
;(getPluginLifecycleHooks as jest.Mock).mockReturnValue({
  dispatchOnTeammateClaim,
  dispatchOnTeammateRelease,
})

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

  it("skill-aware claim prefers the requested teammate when available", () => {
    const a = tm("a")
    const b = tm("b")
    const c = tm("c")
    const pool = createTeammatePool({ teammates: [a, b, c] })
    // Round-robin would start at "a"; the preference jumps to "c".
    expect(pool.claim("t1", { preferTeammateId: "c" })?.id).toBe("c")
    // The preferred claim does not advance the round-robin cursor.
    expect(pool.claim("t2")?.id).toBe("a")
  })

  it("skill-aware claim falls back to round-robin when the preferred teammate is unknown", () => {
    const a = tm("a")
    const b = tm("b")
    const pool = createTeammatePool({ teammates: [a, b] })
    expect(pool.claim("t1", { preferTeammateId: "missing" })?.id).toBe("a")
  })

  it("skill-aware claim falls back to round-robin when the preferred teammate is unavailable", () => {
    const a = tm("a")
    const b = tm("b")
    const pool = createTeammatePool({ teammates: [a, b] })
    // Quarantine "a" via a catastrophic failure (disqualified → unavailable).
    pool.recordFailure("a", new Error("401 Unauthorized: invalid API key"))
    expect(pool.claim("t1", { preferTeammateId: "a" })?.id).toBe("b")
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
})

describe("TeammatePool — error classification (PR 6)", () => {
  it("classifies 401 as catastrophic → disqualified, no auto-recovery", () => {
    const a = tm("a")
    const b = tm("b")
    const pool = createTeammatePool({ teammates: [a, b] })
    pool.recordFailure("a", new Error("401 Unauthorized: invalid API key"))
    expect(pool.isDisqualified("a")).toBe(true)
    expect(pool.availableCount()).toBe(1)
    expect(pool.claim("t1")?.id).toBe("b")
  })

  it("classifies 429 as rate_limited → breaker opens immediately", () => {
    const a = tm("a")
    const b = tm("b")
    const pool = createTeammatePool({
      teammates: [a, b],
      breakerOptions: { minEvents: 100 }, // sliding window would never trip
    })
    pool.recordFailure("a", new Error("429 Too Many Requests"))
    expect(pool.availableCount()).toBe(1)
    expect(pool.isDisqualified("a")).toBe(false)
  })

  it("rejoin clears disqualified and resets breaker", () => {
    const a = tm("a")
    const pool = createTeammatePool({ teammates: [a] })
    pool.recordFailure("a", new Error("401 Unauthorized"))
    expect(pool.isDisqualified("a")).toBe(true)
    pool.rejoin("a")
    expect(pool.isDisqualified("a")).toBe(false)
    expect(pool.claim("t1")?.id).toBe("a")
  })

  it("onTeammateDisqualified edge-triggered per teammate", () => {
    const a = tm("a")
    const b = tm("b")
    const fn = jest.fn()
    const pool = createTeammatePool({ teammates: [a, b] })
    pool.onTeammateDisqualified(fn)
    pool.recordFailure("a", new Error("401"))
    pool.recordFailure("a", new Error("403"))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith("a", "catastrophic")
    pool.recordFailure("b", new Error("404"))
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith("b", "catastrophic")
  })

  it("EMPTY_OUTPUT and REFUSAL_DETECTED treated as ordinary", () => {
    const a = tm("a")
    const pool = createTeammatePool({
      teammates: [a],
      breakerOptions: { minEvents: 2, failureThresholdPct: 50 },
    })
    pool.recordFailure("a", new Error("EMPTY_OUTPUT"))
    pool.recordFailure("a", new Error("REFUSAL_DETECTED"))
    expect(pool.availableCount()).toBe(0)
    expect(pool.isDisqualified("a")).toBe(false)
  })
})

describe("TeammatePool — claim/release plugin hooks (deduped)", () => {
  // Regression guard: the pool MUST NOT dispatch onTeammateClaim/onTeammateRelease.
  // `dispatchTeammate` is the single source of those hooks — firing them here too
  // double-counted every claim/release for plugin consumers.
  beforeEach(() => {
    dispatchOnTeammateClaim.mockClear()
    dispatchOnTeammateRelease.mockClear()
  })

  it("does NOT dispatch when teamId/runId are absent", () => {
    const a = tm("a")
    const pool = createTeammatePool({ teammates: [a] })
    pool.claim("task-1")
    pool.recordSuccess("a")
    expect(dispatchOnTeammateClaim).not.toHaveBeenCalled()
    expect(dispatchOnTeammateRelease).not.toHaveBeenCalled()
  })

  it("does NOT dispatch even when team/run context is present (dispatchTeammate owns the hooks)", () => {
    const a = tm("a")
    const pool = createTeammatePool({ teammates: [a], teamId: "team-1", runId: "run-1" })
    pool.claim("task-1")
    pool.recordSuccess("a")
    pool.claim("task-2")
    pool.recordFailure("a", new Error("boom"))
    expect(dispatchOnTeammateClaim).not.toHaveBeenCalled()
    expect(dispatchOnTeammateRelease).not.toHaveBeenCalled()
  })
})
