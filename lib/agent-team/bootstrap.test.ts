import {
  __resetSquadBootstrapForTesting,
  awaitSquadRuntimeReady,
  getSquadRuntimeState,
  isSquadRuntimeReady,
  runSquadBootstrap,
  type SquadBootstrapDeps,
  type SquadBootstrapStage,
} from "./bootstrap"

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness(over: Partial<SquadBootstrapDeps> = {}) {
  const calls: string[] = []
  const stages: SquadBootstrapStage[] = []
  const disposeBridge = jest.fn(() => calls.push("dispose"))
  const deps: SquadBootstrapDeps = {
    startBridge: () => {
      calls.push("startBridge")
      return disposeBridge
    },
    whenHydrated: async () => {
      calls.push("hydrated")
    },
    setCandidateResolver: () => {
      calls.push("setResolver")
    },
    resolveCandidates: async () => ({}),
    installAdapters: () => {
      calls.push("adapters")
    },
    backfillHistory: async () => {
      calls.push("history")
      return { scanned: 2, imported: 1, skipped: 1, recoveryRequired: 0 }
    },
    recoverInterrupts: async () => {
      calls.push("interrupts")
    },
    recoverRuns: async () => {
      calls.push("runs")
      return [{ runId: "r1", status: "recovering" as const }]
    },
    armRecoveries: async () => {
      calls.push("recoveries")
      return { armed: 1, alreadyPending: 0 }
    },
    onStage: (s) => stages.push(s),
    now: () => 1_000,
    ...over,
  }
  return { calls, stages, deps, disposeBridge }
}

describe("runSquadBootstrap", () => {
  beforeEach(() => __resetSquadBootstrapForTesting())

  it("is idle, and therefore dispatchable, before any bootstrap runs", async () => {
    expect(getSquadRuntimeState()).toBe("idle")
    expect(isSquadRuntimeReady()).toBe(true)
    await expect(awaitSquadRuntimeReady()).resolves.toBe(true)
  })

  it("runs the stages in order and flips ready at the end", async () => {
    const h = harness()
    const handle = runSquadBootstrap(h.deps)
    expect(getSquadRuntimeState()).toBe("starting")
    expect(isSquadRuntimeReady()).toBe(false)

    const outcome = await handle.done
    expect(outcome).toEqual({
      ok: true,
      history: { scanned: 2, imported: 1, skipped: 1, recoveryRequired: 0 },
      recovered: [{ runId: "r1", status: "recovering" }],
      recoveries: { armed: 1, alreadyPending: 0 },
      durationMs: 0,
    })
    expect(h.calls).toEqual([
      "setResolver",
      "startBridge",
      "hydrated",
      "adapters",
      "history",
      "interrupts",
      "runs",
      "recoveries",
    ])
    expect(h.stages).toEqual(["hydrate", "adapters", "import_history", "recover", "ready"])
    expect(getSquadRuntimeState()).toBe("ready")
    await expect(awaitSquadRuntimeReady()).resolves.toBe(true)
  })

  it("makes an early launch wait for readiness instead of racing it", async () => {
    const hydrated = deferred()
    const h = harness({ whenHydrated: () => hydrated.promise })
    const handle = runSquadBootstrap(h.deps)
    const waiting = awaitSquadRuntimeReady()
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    hydrated.resolve()
    await expect(waiting).resolves.toBe(true)
    await handle.done
  })

  it("fails closed: a stage that throws names itself and leaves the runtime refusing", async () => {
    const h = harness({
      installAdapters: () => {
        throw new Error("no deps")
      },
    })
    const outcome = await runSquadBootstrap(h.deps).done
    expect(outcome).toMatchObject({ ok: false, failedStage: "adapters" })
    expect(h.calls).not.toContain("history")
    expect(getSquadRuntimeState()).toBe("failed")
    expect(isSquadRuntimeReady()).toBe(false)
    await expect(awaitSquadRuntimeReady()).resolves.toBe(false)
  })

  it("times out a wait when the bootstrap never finishes", async () => {
    const h = harness({ whenHydrated: () => new Promise<void>(() => {}) })
    runSquadBootstrap(h.deps)
    await expect(awaitSquadRuntimeReady(5)).resolves.toBe(false)
  })

  it("dispose stops the mirror and returns to idle, and a superseded run cannot flip ready", async () => {
    const hydrated = deferred()
    const first = harness({ whenHydrated: () => hydrated.promise })
    const handle = runSquadBootstrap(first.deps)
    handle.dispose()
    expect(getSquadRuntimeState()).toBe("idle")

    const second = harness()
    const next = runSquadBootstrap(second.deps)
    hydrated.resolve()
    const firstOutcome = await handle.done
    expect(firstOutcome.ok).toBe(false)
    // The bridge starts synchronously with the run, so the disposal was
    // immediate and the second run started its own bridge afterwards.
    expect(first.disposeBridge).toHaveBeenCalledTimes(1)
    expect(second.calls.indexOf("startBridge")).toBeGreaterThan(-1)
    const secondOutcome = await next.done
    expect(secondOutcome.ok).toBe(true)
    expect(getSquadRuntimeState()).toBe("ready")
  })

  it("a bootstrap started while one is in flight supersedes it", async () => {
    const hydrated = deferred()
    const first = harness({ whenHydrated: () => hydrated.promise })
    const a = runSquadBootstrap(first.deps)
    const second = harness()
    const b = runSquadBootstrap(second.deps)
    await b.done
    expect(getSquadRuntimeState()).toBe("ready")
    hydrated.resolve()
    const outcome = await a.done
    expect(outcome.ok).toBe(false)
    // The stale run must not have touched the state the live run owns.
    expect(getSquadRuntimeState()).toBe("ready")
    expect(first.calls).not.toContain("adapters")
    // Superseding disposes the older bridge before the newer one starts, so
    // the bridge singleton is never left pointing at a run that lost.
    expect(first.disposeBridge).toHaveBeenCalledTimes(1)
  })

  it("dispose of a superseded run does not touch the live run's bridge", async () => {
    const first = harness({ whenHydrated: () => new Promise<void>(() => {}) })
    const a = runSquadBootstrap(first.deps)
    const second = harness()
    const b = runSquadBootstrap(second.deps)
    a.dispose()
    expect(second.disposeBridge).not.toHaveBeenCalled()
    await b.done
    expect(getSquadRuntimeState()).toBe("ready")
  })
})
