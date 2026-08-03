import {
  __resetPluginActivationProgressStoreForTesting,
  ACTIVATION_PROGRESS_COMPLETED_RETENTION_MS,
  ACTIVATION_PROGRESS_TERMINAL_RETENTION_MS,
  advancePluginActivationProgress,
  beginPluginActivationProgress,
  cancelPluginActivationProgress,
  completePluginActivationProgress,
  configurePluginActivationProgressStore,
  failPluginActivationProgress,
  getPluginActivationProgress,
} from "./plugin-activation-progress-store"

/** Controllable clear scheduler so retention is asserted without real timers. */
function fakeScheduler() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  return {
    pending,
    scheduleClear: (fn: () => void, ms: number) => {
      const entry = { fn, ms, cancelled: false }
      pending.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    runAll: () => {
      for (const entry of pending) if (!entry.cancelled) entry.fn()
    },
  }
}

beforeEach(() => {
  __resetPluginActivationProgressStoreForTesting()
})

afterEach(() => {
  __resetPluginActivationProgressStoreForTesting()
})

describe("begin", () => {
  it("starts at preflight, 0 of 7, running", () => {
    beginPluginActivationProgress("p", { reason: "manual" })
    expect(getPluginActivationProgress("p")).toMatchObject({
      pluginId: "p",
      phase: "preflight",
      processed: 0,
      total: 7,
      status: "running",
      reason: "manual",
    })
  })

  it("records the parent for a dependency activation", () => {
    beginPluginActivationProgress("dep", { reason: "dependency", parentPluginId: "child" })
    expect(getPluginActivationProgress("dep")?.parentPluginId).toBe("child")
  })

  it("replaces an existing entry wholesale so a retry starts clean", () => {
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "runtime")
    failPluginActivationProgress("p", new Error("boom"))

    beginPluginActivationProgress("p")
    expect(getPluginActivationProgress("p")).toMatchObject({
      phase: "preflight",
      processed: 0,
      status: "running",
    })
    expect(getPluginActivationProgress("p")?.errorMessage).toBeUndefined()
  })
})

describe("advance", () => {
  it("walks 0 through 6 monotonically", () => {
    beginPluginActivationProgress("p")
    const seen: number[] = [getPluginActivationProgress("p")!.processed]
    for (const phase of [
      "dependencies",
      "schema",
      "runtime",
      "contributions",
      "hooks",
      "commit",
    ] as const) {
      advancePluginActivationProgress("p", phase)
      seen.push(getPluginActivationProgress("p")!.processed)
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it("is a no-op for a plugin that never began", () => {
    // An already-enabled early return never creates an entry, so the manager's
    // instrumentation must survive advancing into nothing.
    expect(() => advancePluginActivationProgress("ghost", "runtime")).not.toThrow()
    expect(getPluginActivationProgress("ghost")).toBeUndefined()
  })

  it("never moves backwards", () => {
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "commit")
    advancePluginActivationProgress("p", "schema")
    expect(getPluginActivationProgress("p")).toMatchObject({ phase: "commit", processed: 6 })
  })

  it("is inert after a terminal status — a late advance cannot resurrect a failure", () => {
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "contributions")
    failPluginActivationProgress("p", new Error("boom"))
    advancePluginActivationProgress("p", "commit")
    expect(getPluginActivationProgress("p")).toMatchObject({
      status: "failed",
      phase: "contributions",
      processed: 4,
    })
  })
})

describe("terminal states", () => {
  it("complete lands on 7 of 7", () => {
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "commit")
    completePluginActivationProgress("p")
    expect(getPluginActivationProgress("p")).toMatchObject({
      processed: 7,
      status: "completed",
    })
  })

  it("fail preserves the phase and count where the work actually stopped", () => {
    // This IS "failure reports the current phase" — the entry is not reset.
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "contributions")
    failPluginActivationProgress("p", new Error("registerPluginContributions exploded"))
    expect(getPluginActivationProgress("p")).toMatchObject({
      phase: "contributions",
      processed: 4,
      status: "failed",
      errorMessage: "registerPluginContributions exploded",
    })
  })

  it("fail stringifies a non-Error throw", () => {
    beginPluginActivationProgress("p")
    failPluginActivationProgress("p", "plain string")
    expect(getPluginActivationProgress("p")?.errorMessage).toBe("plain string")
  })

  it("cancel preserves the phase and records the reason", () => {
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "runtime")
    cancelPluginActivationProgress("p", "disable")
    expect(getPluginActivationProgress("p")).toMatchObject({
      phase: "runtime",
      processed: 3,
      status: "cancelled",
      reason: "disable",
    })
  })

  it("complete after a failure is ignored", () => {
    beginPluginActivationProgress("p")
    failPluginActivationProgress("p", new Error("boom"))
    completePluginActivationProgress("p")
    expect(getPluginActivationProgress("p")?.status).toBe("failed")
  })

  it("cancelling an unknown plugin is a no-op", () => {
    expect(() => cancelPluginActivationProgress("ghost", "disable")).not.toThrow()
  })
})

describe("retention", () => {
  it("clears a completed entry after the short retention", () => {
    const scheduler = fakeScheduler()
    configurePluginActivationProgressStore({ scheduleClear: scheduler.scheduleClear })

    beginPluginActivationProgress("p")
    completePluginActivationProgress("p")
    expect(scheduler.pending.at(-1)?.ms).toBe(ACTIVATION_PROGRESS_COMPLETED_RETENTION_MS)

    scheduler.runAll()
    expect(getPluginActivationProgress("p")).toBeUndefined()
  })

  it("keeps a failed entry longer so it can be read alongside the toast", () => {
    const scheduler = fakeScheduler()
    configurePluginActivationProgressStore({ scheduleClear: scheduler.scheduleClear })

    beginPluginActivationProgress("p")
    failPluginActivationProgress("p", new Error("boom"))
    expect(scheduler.pending.at(-1)?.ms).toBe(ACTIVATION_PROGRESS_TERMINAL_RETENTION_MS)
  })

  it("outlives the loading region's minimum display so 7/7 is visible", () => {
    // LOADING_MIN_DISPLAY_MS is 320ms; a shorter retention would delete the
    // entry mid-animation and the bar would vanish before landing.
    expect(ACTIVATION_PROGRESS_COMPLETED_RETENTION_MS).toBeGreaterThan(320)
  })

  it("a retry cancels the previous attempt's pending clear", () => {
    // Otherwise the old timer fires mid-retry and deletes the fresh entry.
    const scheduler = fakeScheduler()
    configurePluginActivationProgressStore({ scheduleClear: scheduler.scheduleClear })

    beginPluginActivationProgress("p")
    failPluginActivationProgress("p", new Error("boom"))
    beginPluginActivationProgress("p")

    scheduler.runAll()
    expect(getPluginActivationProgress("p")).toMatchObject({ status: "running" })
  })
})

describe("isolation", () => {
  it("keeps two plugins fully independent", () => {
    beginPluginActivationProgress("a")
    beginPluginActivationProgress("b")
    advancePluginActivationProgress("a", "commit")

    expect(getPluginActivationProgress("a")).toMatchObject({ processed: 6 })
    expect(getPluginActivationProgress("b")).toMatchObject({ processed: 0 })
  })

  it("models a dependency running while its parent waits at `dependencies`", () => {
    // The shape the manager produces: the parent parks at 1/7 for the whole
    // dependency loop while each dep runs its own 0→7 independently.
    beginPluginActivationProgress("child")
    advancePluginActivationProgress("child", "dependencies")

    beginPluginActivationProgress("parent", { parentPluginId: "child" })
    for (const phase of [
      "dependencies",
      "schema",
      "runtime",
      "contributions",
      "hooks",
      "commit",
    ] as const) {
      advancePluginActivationProgress("parent", phase)
    }
    completePluginActivationProgress("parent")

    expect(getPluginActivationProgress("parent")).toMatchObject({
      status: "completed",
      processed: 7,
      parentPluginId: "child",
    })
    expect(getPluginActivationProgress("child")).toMatchObject({
      phase: "dependencies",
      processed: 1,
      status: "running",
    })
  })
})
