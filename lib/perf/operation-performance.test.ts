/** @jest-environment jsdom */
import {
  createOperationPerformanceRecorder,
  getOperationPerformanceRecorder,
  measureOperation,
  OPERATION_NAMES,
  OPERATION_GROUPS,
  OPERATION_PERFORMANCE_STORAGE_KEY,
  type OperationPerformanceDependencies,
  type OperationName,
} from "./operation-performance"

function fixture(dependencies: OperationPerformanceDependencies = {}) {
  let now = 100
  let scope: string | null = "account-a"
  const store = createOperationPerformanceRecorder({
    clock: () => now,
    isBrowser: () => true,
    readScope: () => scope,
    ...dependencies,
  })
  const release = store.connect()
  store.setEnabled(true)
  return {
    store,
    release,
    setNow: (value: number) => {
      now = value
    },
    setScope: (value: string | null) => {
      scope = value
      store.setScope(scope)
    },
  }
}
const row = (
  store: ReturnType<typeof createOperationPerformanceRecorder>,
  name: OperationName = "storage.messages.load"
) => store.getSnapshot().rows.find((item) => item.name === name)!

beforeEach(() => localStorage.clear())
afterEach(() => jest.restoreAllMocks())

it("defaults off and loads persisted opt-in before panel connection", () => {
  const recorder = createOperationPerformanceRecorder()
  const stable = recorder.getSnapshot()
  expect(recorder.getSnapshot()).toBe(stable)
  recorder.begin("storage.messages.load")()
  expect(row(recorder).count).toBe(0)
  localStorage.setItem(OPERATION_PERFORMANCE_STORAGE_KEY, JSON.stringify({ enabled: true }))
  const restored = createOperationPerformanceRecorder()
  restored.begin("storage.messages.load")()
  expect(row(restored).count).toBe(1)
  expect(restored.getServerSnapshot().settings.enabled).toBe(false)
  recorder.connect()()
  restored.connect()()
})

it("keeps collection independent of panel connections and cleanup idempotent", () => {
  const { store, release } = fixture()
  const other = store.connect()
  release()
  release()
  other()
  store.begin("storage.messages.load")()
  expect(row(store).count).toBe(1)
  store.connect()()
})

it("records zero durations, errors, cancellations and idempotent completion", () => {
  const { store, release, setNow } = fixture()
  const finish = store.begin("storage.messages.load")
  expect(row(store).inFlight).toBe(1)
  finish("error")
  finish("cancelled")
  const next = store.begin("storage.messages.load")
  setNow(120)
  next("cancelled")
  expect(row(store)).toMatchObject({
    count: 2,
    errors: 1,
    cancelled: 1,
    inFlight: 0,
    samples: 2,
    p50Ms: 10,
    p95Ms: 19,
    maxMs: 20,
    lastMs: 20,
  })
  expect(store.collectInterval()).toMatchObject({
    "renderer.operation.count": 2,
    "renderer.operation.error.count": 1,
    "renderer.operation.cancelled.count": 1,
    "renderer.operation.duration.p95.ms": 19,
  })
  expect(store.collectInterval()["renderer.operation.count"]).toBe(0)
  expect(row(store).count).toBe(2)
  release()
})

it("invalidates callbacks on clear, master toggle and per-group toggle", () => {
  const { store, release } = fixture()
  const stale = store.begin("storage.messages.load")
  store.clear()
  stale()
  expect(row(store).count).toBe(0)
  const staleOff = store.begin("storage.messages.load")
  store.setEnabled(false)
  store.setEnabled(true)
  staleOff()
  expect(row(store).count).toBe(0)
  const keep = store.begin("transport.local.call")
  const drop = store.begin("storage.messages.load")
  store.setGroupEnabled("storage", false)
  store.setGroupEnabled("storage", true)
  drop()
  keep()
  expect(row(store).count).toBe(0)
  expect(row(store, "transport.local.call").count).toBe(1)
  release()
})

it("keeps exact interval counts but nulls p95 on overflow and bounds rows", () => {
  const { store, release, setNow } = fixture()
  for (let i = 0; i < 510; i++) {
    setNow(i * 1000)
    const done = store.begin("storage.messages.load")
    setNow(i * 1000 + i)
    done()
  }
  expect(store.getSnapshot().rows).toHaveLength(OPERATION_NAMES.length)
  expect(row(store)).toMatchObject({
    count: 510,
    samples: 120,
    maxMs: 509,
    lastMs: 509,
    p50Ms: 449.5,
  })
  expect(store.collectInterval()).toMatchObject({
    "renderer.operation.count": 510,
    "renderer.operation.duration.p95.ms": null,
  })
  expect(store.collectInterval()["renderer.operation.duration.p95.ms"]).toBeNull()
  release()
})

it("caps active operations and ignores unknown operation names", () => {
  const { store, release } = fixture()
  const pending = Array.from({ length: 257 }, () => store.begin("storage.messages.load"))
  store.begin("https://secret.invalid" as OperationName)()
  expect(row(store).inFlight).toBe(256)
  expect(store.getSnapshot().dropped).toBe(1)
  pending.forEach((done) => done())
  expect(row(store)).toMatchObject({ inFlight: 0, count: 256 })
  store.clear()
  expect(store.getSnapshot().dropped).toBe(0)
  release()
})

it("resetInterval preserves rows and in-flight callbacks and disabled all groups report null", () => {
  const { store, release } = fixture()
  store.begin("storage.messages.load")()
  const pending = store.begin("storage.messages.load")
  store.resetInterval()
  expect(store.collectInterval()).toMatchObject({
    "renderer.operation.count": 0,
    "renderer.operation.inflight.count": 1,
  })
  pending()
  expect(row(store).count).toBe(2)
  for (const group of OPERATION_GROUPS) store.setGroupEnabled(group, false)
  expect(Object.values(store.collectInterval()).every((value) => value === null)).toBe(true)
  release()
})

it("cross-tab opt-out cancels active operations and storage removal restores defaults", () => {
  const { store, release } = fixture()
  const stale = store.begin("storage.messages.load")
  localStorage.setItem(OPERATION_PERFORMANCE_STORAGE_KEY, JSON.stringify({ enabled: false }))
  window.dispatchEvent(new StorageEvent("storage", { key: OPERATION_PERFORMANCE_STORAGE_KEY }))
  stale()
  expect(store.getSnapshot().settings.enabled).toBe(false)
  expect(row(store).count).toBe(0)
  store.setEnabled(true)
  localStorage.clear()
  window.dispatchEvent(new StorageEvent("storage", { key: null }))
  expect(store.getSnapshot().settings.enabled).toBe(false)
  release()
})

it("fails closed on malformed persistence but applies session controls if writes fail", () => {
  const storage = {
    getItem: jest.fn(() => "{invalid"),
    setItem: jest.fn(() => {
      throw new Error("denied")
    }),
  }
  const store = createOperationPerformanceRecorder({ storage })
  const release = store.connect()
  expect(store.getSnapshot()).toMatchObject({
    settings: { enabled: false },
    persistenceError: true,
  })
  store.setEnabled(true)
  store.begin("storage.messages.load")()
  expect(row(store).count).toBe(1)
  store.setEnabled(false)
  expect(store.getSnapshot()).toMatchObject({
    settings: { enabled: false },
    persistenceError: true,
  })
  release()
})

it("drops previous scope history and pending callbacks, including lock to null", () => {
  const { store, setScope, release } = fixture()
  store.begin("storage.messages.load")()
  const pending = store.begin("storage.messages.load")
  setScope("account-b")
  pending()
  expect(row(store)).toMatchObject({ count: 0, inFlight: 0 })
  store.begin("storage.messages.load")()
  setScope(null)
  expect(row(store).count).toBe(0)
  expect(JSON.stringify(store.getSnapshot())).not.toContain("account-b")
  release()
})

it("detects scope changes at completion even before initializer subscription", () => {
  let scope = "a"
  const { store, release } = fixture({ readScope: () => scope })
  const pending = store.begin("storage.messages.load")
  scope = "b"
  pending()
  expect(row(store).count).toBe(0)
  release()
})

it("remains inert in SSR/headless and contains clock/subscriber failures", () => {
  const headless = createOperationPerformanceRecorder({ isBrowser: () => false })
  headless.setEnabled(true)
  headless.begin("storage.messages.load")()
  expect(row(headless).count).toBe(0)
  const { store, release } = fixture({
    clock: () => {
      throw new Error("no clock")
    },
  })
  store.subscribe(() => {
    throw new Error("broken view")
  })
  expect(() => store.begin("storage.messages.load")()).not.toThrow()
  expect(row(store)).toMatchObject({ count: 1, samples: 0, lastMs: null })
  release()
})

it("preserves original promise identity, values, AbortError and sync throw identity", async () => {
  const { store, release } = fixture()
  jest.spyOn(getOperationPerformanceRecorder(), "begin").mockImplementation(store.begin)
  const promise = Promise.resolve(42)
  const operation = jest.fn(() => promise)
  expect(measureOperation("storage.messages.load", operation)).toBe(promise)
  expect(operation).toHaveBeenCalledTimes(1)
  await promise
  const error = new DOMException("stop", "AbortError")
  const rejected = Promise.reject(error)
  expect(measureOperation("storage.messages.load", () => rejected)).toBe(rejected)
  await expect(rejected).rejects.toBe(error)
  const opaque = Object.create(null)
  Object.defineProperty(opaque, "name", {
    get: () => {
      throw new Error("getter")
    },
  })
  try {
    measureOperation("storage.messages.load", () => {
      throw opaque
    })
  } catch (caught) {
    expect(caught).toBe(opaque)
  }
  expect(row(store)).toMatchObject({ count: 3, errors: 1, cancelled: 1 })
  release()
})

it("preserves Dexie-style thenable identity and synchronous callback invocation", () => {
  const { store, release } = fixture()
  jest.spyOn(getOperationPerformanceRecorder(), "begin").mockImplementation(store.begin)
  const thenable = {
    then: jest.fn((fulfilled: (value: number) => void) => {
      fulfilled(7)
      return { then: jest.fn() }
    }),
  } as unknown as Promise<number>
  let called = false
  expect(
    measureOperation("storage.messages.write", () => {
      called = true
      return thenable
    })
  ).toBe(thenable)
  expect(called).toBe(true)
  expect(row(store, "storage.messages.write").count).toBe(1)
  release()
})

it("classifies unsuccessful HTTP responses without replacing results or propagating classifier failures", async () => {
  const { store, release } = fixture()
  jest.spyOn(getOperationPerformanceRecorder(), "begin").mockImplementation(store.begin)
  const promise = Promise.resolve({ ok: false })
  expect(
    measureOperation(
      "network.browser.fetch",
      () => promise,
      (response) => (response.ok ? "success" : "error")
    )
  ).toBe(promise)
  await promise
  await measureOperation(
    "network.browser.fetch",
    () => promise,
    () => {
      throw new Error("diagnostic")
    }
  )
  expect(row(store, "network.browser.fetch")).toMatchObject({ count: 2, errors: 1 })
  release()
})

it("reloads disconnected preferences before a pending operation can complete", () => {
  const { store, release } = fixture()
  const done = store.begin("storage.messages.load")
  release()
  localStorage.setItem(OPERATION_PERFORMANCE_STORAGE_KEY, JSON.stringify({ enabled: false }))
  done()
  expect(row(store).count).toBe(0)
  expect(store.getSnapshot().settings.enabled).toBe(false)
  store.connect()()
})

it("ignores sessionStorage events even when the key matches", () => {
  const { store, release } = fixture()
  const done = store.begin("storage.messages.load")
  localStorage.setItem(OPERATION_PERFORMANCE_STORAGE_KEY, JSON.stringify({ enabled: false }))
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: OPERATION_PERFORMANCE_STORAGE_KEY,
      storageArea: sessionStorage,
    })
  )
  done()
  expect(store.getSnapshot().settings.enabled).toBe(true)
  expect(row(store).count).toBe(1)
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: OPERATION_PERFORMANCE_STORAGE_KEY,
      storageArea: localStorage,
    })
  )
  expect(store.getSnapshot().settings.enabled).toBe(false)
  release()
})

it("keeps a failed persisted opt-out effective across reconnects and storage notifications", () => {
  let persisted = JSON.stringify({ enabled: true })
  let fail = true
  const storage = {
    getItem: () => persisted,
    setItem: (_key: string, value: string) => {
      if (fail) throw new Error("quota")
      persisted = value
    },
  }
  const store = createOperationPerformanceRecorder({ storage })
  const disconnect = store.connect()
  expect(store.getSnapshot().settings.enabled).toBe(true)
  store.setEnabled(false)
  disconnect()
  const reconnect = store.connect()
  window.dispatchEvent(new StorageEvent("storage", { key: OPERATION_PERFORMANCE_STORAGE_KEY }))
  store.begin("storage.messages.load")()
  expect(store.getSnapshot()).toMatchObject({
    settings: { enabled: false },
    persistenceError: true,
  })
  expect(row(store).count).toBe(0)
  fail = false
  store.setEnabled(false)
  expect(store.getSnapshot().persistenceError).toBe(false)
  persisted = JSON.stringify({ enabled: true })
  window.dispatchEvent(new StorageEvent("storage", { key: OPERATION_PERFORMANCE_STORAGE_KEY }))
  expect(store.getSnapshot().settings.enabled).toBe(true)
  reconnect()
})

it("does not attach promise handlers or invoke classifiers while collection is disabled", () => {
  const { store, release } = fixture()
  store.setEnabled(false)
  jest.spyOn(getOperationPerformanceRecorder(), "begin").mockImplementation(store.begin)
  const promise = Promise.resolve(1)
  const then = jest.spyOn(promise, "then")
  const classifier = jest.fn(() => "success" as const)
  expect(measureOperation("storage.messages.load", () => promise, classifier)).toBe(promise)
  expect(then).not.toHaveBeenCalled()
  expect(classifier).not.toHaveBeenCalled()
  release()
})

it("keeps an early boot sample when first connection has the same scope", () => {
  localStorage.setItem(OPERATION_PERFORMANCE_STORAGE_KEY, JSON.stringify({ enabled: true }))
  const store = createOperationPerformanceRecorder({ readScope: () => "selected-account-target" })
  store.begin("startup.capability-probe")()
  store.setScope("selected-account-target")
  const release = store.connect()
  expect(row(store, "startup.capability-probe").count).toBe(1)
  release()
})

it("still accepts stricter cross-tab opt-outs when a local setting write failed", () => {
  let persisted = JSON.stringify({ enabled: true })
  const storage = {
    getItem: () => persisted,
    setItem: () => {
      throw new Error("quota")
    },
  }
  const store = createOperationPerformanceRecorder({ storage })
  const release = store.connect()
  store.setGroupEnabled("network", false)
  const pending = store.begin("storage.messages.load")
  persisted = JSON.stringify({ enabled: false })
  window.dispatchEvent(new StorageEvent("storage", { key: OPERATION_PERFORMANCE_STORAGE_KEY }))
  pending()
  expect(store.getSnapshot().settings.enabled).toBe(false)
  expect(store.getSnapshot().settings.groups.network).toBe(false)
  expect(row(store).count).toBe(0)
  release()
  const reconnect = store.connect()
  expect(store.getSnapshot().settings.enabled).toBe(false)
  reconnect()
})
