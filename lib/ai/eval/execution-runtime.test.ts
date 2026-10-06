/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import type { EvalEnvironmentCompatibility, EvalProject } from "@cognia/eval-core"
import type { AppSettings } from "@cognia/agent-config-types"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { EvalProjectService } from "./project-service"
import {
  EvalExecutionRuntime,
  EvalRuntimeScopeError,
  getEvalExecutionRuntime,
  type EvalExecutionRuntimeOptions,
} from "./execution-runtime"
import { useAccountStore } from "@/stores/account/account-store"
import {
  setActiveRuntimeTargetContext,
  clearActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import type { createBrowserEvalOrchestrator } from "./browser-execution"

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: jest.fn(), subscribe: jest.fn() },
}))
jest.mock("./runtime-context", () => ({ loadEvalAppSettings: jest.fn() }))
jest.mock("./environment-preflight", () => ({ checkEvalEnvironmentCompatibility: jest.fn() }))
jest.mock("./browser-execution", () => ({ createBrowserEvalOrchestrator: jest.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function waitFor(check: () => void | Promise<void>) {
  for (let i = 0; i < 100; i++) {
    try {
      await check()
      return
    } catch (error) {
      if (i === 99) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const project = (): EvalProject => ({
  id: "project-1",
  name: "Selection",
  mode: "model",
  dataset: {
    datasetId: "dataset-1",
    version: 2,
    digest: "sha256:dataset",
    caseIds: Array.from({ length: 30 }, (_, i) => `case-${i}`),
    holdoutCaseIds: Array.from({ length: 30 }, (_, i) => `case-${i}`),
    requiredModalities: ["text"],
  },
  variants: ["a", "b"].map((id) => ({
    id,
    name: id,
    kind: "model" as const,
    providerId: `provider-${id}`,
    modelId: `model-${id}`,
    runtimeTarget: "web" as const,
    isLocal: true,
    capabilities: ["text" as const],
    available: true,
    credentialReady: true,
  })),
  decisionPolicy: {
    formal: false,
    dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
    constraints: [],
    confidenceLevel: 0.95,
    minimumEffectiveCases: 30,
  },
  budget: { currency: "USD", hardCap: 10, confirmed: true },
  judgePolicy: { enabled: false, calibrated: false, anchorCount: 0, kappa: 0, accuracy: 0 },
  privacyPolicy: { cloudPiiMode: "redact", mediaClearance: "local-only" },
  retentionDays: 90,
  createdAt: 1,
  updatedAt: 1,
})

const environment: EvalEnvironmentCompatibility = {
  checkedAt: 50,
  runtimeByVariant: { a: { available: true }, b: { available: true } },
  storage: { status: "available", requiredBytes: 1, availableBytes: 100 },
}

describe("scope-owned evaluation execution", () => {
  const runtimes: EvalExecutionRuntime[] = []
  function setup(overrides: Partial<EvalExecutionRuntimeOptions> = {}) {
    const done = deferred<void>()
    const engine = {
      run: jest.fn(() => done.promise),
      cancel: jest.fn(async () => {}),
      interrupt: jest.fn(),
    }
    const key = new Uint8Array(32).fill(7)
    const acquireLock = jest.fn(async () => true)
    const createOrchestrator = jest.fn(() => engine) as unknown as jest.MockedFunction<
      typeof createBrowserEvalOrchestrator
    >
    const runtime = new EvalExecutionRuntime({
      scope: { accountId: "account-a", targetId: "web", routingGeneration: 1 },
      db: getDb(),
      assertActive: () => {},
      loadKey: async () => key,
      loadSettings: async () => ({}) as AppSettings,
      createOrchestrator,
      checkEnvironment: async () => environment,
      acquireLock,
      ...overrides,
    })
    runtimes.push(runtime)
    return { runtime, done, engine, key, acquireLock, createOrchestrator }
  }
  async function seed(state: "running" | "paused" = "running") {
    await getDb().evalProjects.put(project())
    const experiment = await new EvalProjectService().start("project-1", {
      appVersion: "1",
      scorerVersions: {},
      randomSeed: 1,
      environmentCompatibility: environment,
    })
    await getDb().evalExperiments.update(experiment.id, { state })
    return experiment.id
  }
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) runtime.dispose()
    await getDb().delete()
    __resetDbForTesting()
  })

  it("deduplicates simultaneous starts and keeps execution alive after observer unmount", async () => {
    const { runtime, engine, done, createOrchestrator } = setup()
    const starting = runtime.start(project())
    expect(runtime.start(project())).toBe(starting)
    const id = await starting
    expect(engine.run).toHaveBeenCalledTimes(1)
    expect(await getDb().evalExperiments.count()).toBe(1)
    const unsubscribe = runtime.subscribe(id, () => {})
    unsubscribe()
    expect(engine.interrupt).not.toHaveBeenCalled()
    expect(createOrchestrator.mock.calls[0][0].scope?.db).toBe(getDb())
    done.resolve()
  })

  it("reattaches observers to the live owner without treating its run as crashed", async () => {
    const { runtime, engine } = setup()
    const id = await runtime.start(project())
    await getDb().evalExperiments.update(id, { state: "running" })
    await expect(runtime.recover()).resolves.toEqual([{ experimentId: id, state: "running" }])
    expect((await getDb().evalExperiments.get(id))?.state).toBe("running")
    expect(engine.run).toHaveBeenCalledTimes(1)
  })

  it("launches safely queued recovered work without creating another experiment", async () => {
    const id = await seed("paused")
    await getDb().evalExperiments.update(id, { state: "queued" })
    const { runtime, engine } = setup()
    await expect(runtime.start(project())).resolves.toBe(id)
    expect(await getDb().evalExperiments.count()).toBe(1)
    expect(engine.run).toHaveBeenCalledWith(id)
  })

  it("rejects late initialization after scope teardown before creating any experiment", async () => {
    const pending = deferred<Uint8Array>()
    const { runtime, engine } = setup({ loadKey: () => pending.promise })
    const start = runtime.start(project())
    runtime.dispose()
    pending.resolve(new Uint8Array(32))
    await expect(start).rejects.toBeInstanceOf(EvalRuntimeScopeError)
    expect(await getDb().evalExperiments.count()).toBe(0)
    expect(engine.run).not.toHaveBeenCalled()
  })

  it("interrupts execution, invalidates scoped dependencies, and notifies observers on disposal", async () => {
    const { runtime, engine, createOrchestrator, key } = setup()
    const id = await runtime.start(project())
    const onError = jest.fn()
    runtime.subscribe(id, () => {}, onError)
    const options = createOrchestrator.mock.calls[0][0]
    runtime.dispose()
    expect(engine.interrupt).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(EvalRuntimeScopeError))
    expect(() => options.scope?.assertActive()).toThrow(EvalRuntimeScopeError)
    expect(options.artifactKey).toEqual(new Uint8Array(32))
    expect(key[0]).toBe(7)
    await expect(runtime.status(id)).rejects.toBeInstanceOf(EvalRuntimeScopeError)
  })

  it("leaves another window's live run untouched and still permits read/cancel", async () => {
    const id = await seed()
    const { runtime, acquireLock } = setup({ acquireLock: jest.fn(async () => false) })
    await expect(runtime.recover()).resolves.toEqual([{ experimentId: id, state: "running" }])
    await expect(runtime.status(id)).resolves.toMatchObject({ state: "running" })
    await runtime.cancel(id)
    expect((await getDb().evalExperiments.get(id))?.state).toBe("cancelled")
    expect(acquireLock).not.toHaveBeenCalled()
  })

  it("re-reads recovery candidates after obtaining ownership", async () => {
    const id = await seed()
    const { runtime } = setup({
      acquireLock: async () => {
        await getDb().evalExperiments.update(id, { state: "completed" })
        return true
      },
    })
    await expect(runtime.recover()).resolves.toEqual([])
    expect((await getDb().evalExperiments.get(id))?.state).toBe("completed")
  })

  it("retries review initialization after a transient key failure", async () => {
    const loadKey = jest
      .fn()
      .mockRejectedValueOnce(new Error("key unavailable"))
      .mockResolvedValue(new Uint8Array(32))
    const { runtime } = setup({ loadKey })
    await expect(runtime.getReviewService()).rejects.toThrow("key unavailable")
    const service = await runtime.getReviewService()
    expect(await runtime.getReviewService()).toBe(service)
    expect(loadKey).toHaveBeenCalledTimes(2)
  })

  it("restarts queued work if resume races with a loop that already observed pause", async () => {
    const { runtime, engine, done } = setup()
    const id = await runtime.start(project())
    await runtime.pause(id)
    await runtime.resume(id)
    expect(engine.run).toHaveBeenCalledTimes(1)
    done.resolve()
    await waitFor(() => expect(engine.run).toHaveBeenCalledTimes(2))
  })

  it("delivers execution failures to subscribed observers without a DB mutation", async () => {
    const { runtime, done } = setup()
    const id = await runtime.start(project())
    const listener = jest.fn()
    runtime.subscribe(id, listener)
    done.reject(new Error("execution transport failed"))
    await waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ error: "execution transport failed" })
      )
    )
  })

  it("observes a remote cancellation once and aborts the owned engine", async () => {
    const { runtime, engine } = setup()
    const id = await runtime.start(project())
    await getDb().evalExperiments.update(id, { state: "cancelled" })
    await waitFor(() => expect(engine.cancel).toHaveBeenCalledTimes(1))
    await getDb().evalExperiments.update(id, { updatedAt: Date.now() })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(engine.cancel).toHaveBeenCalledTimes(1)
  })
})

describe("active runtime lifetime", () => {
  let account: { unlockedAccountId: string; accountRevision: number; locked: boolean }
  let listeners: Set<() => void>
  beforeEach(() => {
    account = { unlockedAccountId: "account-a", accountRevision: 1, locked: false }
    listeners = new Set()
    jest
      .mocked(useAccountStore.getState)
      .mockImplementation(() => account as ReturnType<typeof useAccountStore.getState>)
    jest.mocked(useAccountStore.subscribe).mockImplementation((listener) => {
      const callback = listener as unknown as () => void
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    })
    setActiveRuntimeTargetContext("account-a", "web", 1)
  })
  afterEach(() => clearActiveRuntimeTargetContext())

  it("returns one owner through repeated UI acquisitions and disposes on direct target change", () => {
    const first = getEvalExecutionRuntime()
    expect(getEvalExecutionRuntime()).toBe(first)
    setActiveRuntimeTargetContext("account-a", "other-target", 2)
    expect(() => first.assertActive()).toThrow(EvalRuntimeScopeError)
    expect(getEvalExecutionRuntime()).not.toBe(first)
  })

  it("rejects recreation while account lock teardown is pending", () => {
    const first = getEvalExecutionRuntime()
    account = { ...account, locked: true, accountRevision: 2 }
    for (const listener of [...listeners]) listener()
    expect(() => first.assertActive()).toThrow(EvalRuntimeScopeError)
    expect(() => getEvalExecutionRuntime()).toThrow(EvalRuntimeScopeError)
    expect(listeners.size).toBe(0)
  })

  it("fences a replaced database even when account and target identifiers match", () => {
    const first = getEvalExecutionRuntime()
    __resetDbForTesting()
    expect(() => first.assertActive()).toThrow(EvalRuntimeScopeError)
    expect(getEvalExecutionRuntime()).not.toBe(first)
  })
})
