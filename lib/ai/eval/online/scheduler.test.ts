import {
  ONLINE_EVAL_DRAIN_BATCH,
  ONLINE_EVAL_DRAIN_INTERVAL_MS,
  startOnlineEvalScheduler,
} from "./scheduler"

const emptyResult = {
  claimed: 0,
  evaluated: 0,
  skipped: 0,
  failed: 0,
  observations: 0,
  judgeDecisions: {},
}

function harness(overrides: Record<string, unknown> = {}) {
  let tick: (() => void) | undefined
  const drain = jest.fn(async () => emptyResult)
  const refreshPolicies = jest.fn(async () => 1)
  const clearIntervalFn = jest.fn()
  const deps = {
    refreshPolicies,
    hasPolicies: () => true,
    drain,
    setIntervalFn: ((fn: () => void) => {
      tick = fn
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval,
    clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    ...overrides,
  }
  return { deps, drain, refreshPolicies, clearIntervalFn, fire: () => tick?.() }
}

describe("startOnlineEvalScheduler", () => {
  it("drains once at boot so work stranded by a previous session is picked up", async () => {
    // A row left `queued` by a closed session can never be pruned, because the
    // sweep only reaches settled rows.
    const { deps, drain } = harness()
    await startOnlineEvalScheduler(deps)
    expect(drain).toHaveBeenCalledWith(ONLINE_EVAL_DRAIN_BATCH)
  })

  it("does not drain when no policy is enabled", async () => {
    const { deps, drain } = harness({ hasPolicies: () => false })
    await startOnlineEvalScheduler(deps)
    expect(drain).not.toHaveBeenCalled()
  })

  it("refreshes the cache on every tick, so a policy added later takes effect", async () => {
    // Refreshing only at boot would mean a policy the user just created does
    // nothing until the next reload.
    const { deps, refreshPolicies, fire } = harness()
    await startOnlineEvalScheduler(deps)
    expect(refreshPolicies).toHaveBeenCalledTimes(1)
    fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(refreshPolicies).toHaveBeenCalledTimes(2)
  })

  it("survives a failing drain rather than taking the app down", async () => {
    const { deps, fire } = harness({
      drain: jest.fn(async () => {
        throw new Error("dexie closed")
      }),
    })
    await expect(startOnlineEvalScheduler(deps)).resolves.toBeInstanceOf(Function)
    expect(() => fire()).not.toThrow()
  })

  it("returns a working unsubscribe even when nothing was scheduled", async () => {
    const { deps, clearIntervalFn } = harness({ hasPolicies: () => false })
    const unsubscribe = await startOnlineEvalScheduler(deps)
    unsubscribe()
    expect(clearIntervalFn).toHaveBeenCalled()
  })

  it("uses a slow interval — this is a background signal, not a live view", () => {
    expect(ONLINE_EVAL_DRAIN_INTERVAL_MS).toBeGreaterThanOrEqual(30_000)
  })
})
