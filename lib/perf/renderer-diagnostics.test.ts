/** @jest-environment jsdom */
import {
  createRendererDiagnostics,
  RENDERER_DIAGNOSTICS_STORAGE_KEY,
  type RendererDiagnosticEntry,
  type RendererDiagnosticsDependencies,
} from "./renderer-diagnostics"

function fixture(dependencies: RendererDiagnosticsDependencies = {}) {
  let now = 100
  const observers: {
    callback: (entries: readonly RendererDiagnosticEntry[]) => void
    observe: jest.Mock
    disconnect: jest.Mock
  }[] = []
  const store = createRendererDiagnostics({
    supportedEntryTypes: ["resource", "event", "navigation"],
    supportsEventTiming: true,
    supportsFrames: true,
    now: () => now,
    readNavigation: () => null,
    createObserver: (callback) => {
      const observer = { callback, observe: jest.fn(), disconnect: jest.fn() }
      observers.push(observer)
      return observer
    },
    ...dependencies,
  })
  const release = store.acquire()
  store.updateSettings({ enabled: true })
  return {
    store,
    observers,
    release,
    setNow: (value: number) => {
      now = value
    },
  }
}

describe("renderer diagnostics", () => {
  beforeEach(() => localStorage.clear())

  it("requires both opt-in and active demand, and releases observers with the last demand", () => {
    const observers: { disconnect: jest.Mock }[] = []
    const createObserver = jest.fn(() => {
      const observer = { observe: jest.fn(), disconnect: jest.fn() }
      observers.push(observer)
      return observer
    })
    const store = createRendererDiagnostics({
      supportedEntryTypes: ["resource", "event", "navigation"],
      supportsEventTiming: true,
      supportsFrames: true,
      createObserver,
    })
    const disconnect = store.connect()
    expect(store.getSnapshot().settings.enabled).toBe(false)
    store.updateSettings({ enabled: true })
    expect(createObserver).not.toHaveBeenCalled()
    const release = store.acquire()
    const releaseOther = store.acquire()
    expect(createObserver).toHaveBeenCalledTimes(2)
    release()
    expect(observers.every((observer) => observer.disconnect.mock.calls.length === 0)).toBe(true)
    releaseOther()
    expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true)
    releaseOther()
    disconnect()
  })

  it("keeps unknown bytes distinct from observed zero and drains only post-opt-in scalar samples", () => {
    const { store, observers, release } = fixture()
    const resource = observers[0]
    expect(resource.observe).toHaveBeenCalledWith({ type: "resource", buffered: false })
    expect(store.collectInterval()).toMatchObject({
      "renderer.resource.count": 0,
      "renderer.resource.duration.p95.ms": null,
      "renderer.resource.transfer.bytes": null,
    })
    resource.callback([
      { startTime: 99, duration: 900, transferSize: 500 },
      { startTime: 100, duration: 10, transferSize: 0, encodedBodySize: 0, responseStart: 0 },
    ])
    expect(store.collectInterval()).toMatchObject({
      "renderer.resource.count": 1,
      "renderer.resource.duration.p95.ms": 10,
      "renderer.resource.transfer.bytes": null,
    })
    resource.callback([{ startTime: 101, duration: 0, transferSize: 0, encodedBodySize: 50 }])
    expect(store.collectInterval()["renderer.resource.transfer.bytes"]).toBe(0)
    resource.callback([
      { startTime: 102, duration: 20, transferSize: 200 },
      { startTime: 103, duration: 30, transferSize: 300 },
    ])
    expect(store.collectInterval()["renderer.resource.transfer.bytes"]).toBe(500)
    expect(store.collectInterval()["renderer.resource.count"]).toBe(0)
    release()
  })

  it("summarizes individual slow-event input and processing delay without keeping event targets", () => {
    const { store, observers, release } = fixture()
    expect(observers[1].observe).toHaveBeenCalledWith({
      type: "event",
      buffered: false,
      durationThreshold: 16,
    })
    observers[1].callback([
      { startTime: 100, duration: 24, processingStart: 104, processingEnd: 112 },
      { startTime: 110, duration: 48, processingStart: 120, processingEnd: 140 },
      { startTime: 111, duration: 32, processingStart: 110, processingEnd: 120 },
      { startTime: 112, duration: Number.NaN, processingStart: 120, processingEnd: 140 },
    ])
    expect(store.collectInterval()).toMatchObject({
      "renderer.event.count": 2,
      "renderer.event.input-delay.p95.ms": 9.7,
      "renderer.event.processing.p95.ms": 19.4,
    })
    expect(store.collectInterval()["renderer.event.input-delay.p95.ms"]).toBeNull()
    release()
  })

  it("ignores queued callbacks after opt-out and after an off/on cycle without losing other groups", () => {
    const { store, observers, release } = fixture()
    const oldResource = observers[0]
    oldResource.callback([{ startTime: 110, duration: 10 }])
    observers[1].callback([
      { startTime: 110, duration: 32, processingStart: 120, processingEnd: 125 },
    ])
    store.updateSettings({ resources: false })
    oldResource.callback([{ startTime: 120, duration: 50 }])
    expect(store.collectInterval()).toMatchObject({
      "renderer.resource.count": null,
      "renderer.event.count": 1,
    })
    store.updateSettings({ resources: true })
    oldResource.callback([{ startTime: 120, duration: 50 }])
    expect(store.collectInterval()["renderer.resource.count"]).toBe(0)
    store.updateSettings({ enabled: false })
    expect(Object.values(store.collectInterval()).every((value) => value === null)).toBe(true)
    release()
  })

  it("withholds percentiles when the bounded interval buffer overflows while counting every observation", () => {
    const { store, observers, release } = fixture()
    observers[0].callback(
      Array.from({ length: 1000 }, (_, index) => ({
        startTime: 100 + index,
        duration: index < 500 ? 999 : 10,
      }))
    )
    expect(store.collectInterval()).toMatchObject({
      "renderer.resource.count": 1000,
      "renderer.resource.duration.p95.ms": null,
    })
    release()
  })

  it("clearing navigation leaves unrelated interval observations intact", () => {
    const { store, observers, release } = fixture()
    observers[0].callback([{ startTime: 110, duration: 10 }])
    store.clear()
    expect(store.collectInterval()).toMatchObject({
      "renderer.resource.count": 1,
      "renderer.resource.duration.p95.ms": 10,
    })
    release()
  })

  it("starts a clean interval after a routing reset without changing navigation or settings", () => {
    const { store, observers, setNow, release } = fixture({
      readNavigation: () => ({ startTime: 0, domInteractive: 70, loadEventEnd: 90 }),
    })
    observers[0].callback([{ startTime: 110, duration: 10, transferSize: 80 }])
    observers[1].callback([
      { startTime: 110, duration: 32, processingStart: 120, processingEnd: 130 },
    ])
    const snapshot = store.getSnapshot()
    setNow(200)
    store.resetInterval()
    expect(store.getSnapshot()).toBe(snapshot)
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1)
    expect(observers[1].disconnect).toHaveBeenCalledTimes(1)
    observers[0].callback([{ startTime: 201, duration: 999 }])
    observers[1].callback([
      { startTime: 201, duration: 999, processingStart: 250, processingEnd: 600 },
    ])
    observers[2].callback([
      { startTime: 199, duration: 999 },
      { startTime: 201, duration: 20 },
    ])
    observers[3].callback([
      { startTime: 199, duration: 999, processingStart: 250, processingEnd: 600 },
      { startTime: 202, duration: 32, processingStart: 206, processingEnd: 212 },
    ])
    expect(store.collectInterval()).toMatchObject({
      "renderer.resource.count": 1,
      "renderer.resource.duration.p95.ms": 20,
      "renderer.resource.transfer.bytes": null,
      "renderer.event.count": 1,
      "renderer.event.input-delay.p95.ms": 4,
      "renderer.event.processing.p95.ms": 6,
    })
    expect(store.getSnapshot().navigation).toMatchObject({ domInteractiveMs: 70, loadMs: 90 })
    release()
    store.resetInterval()
    expect(observers).toHaveLength(4)
  })

  it("refreshes navigation milestones until complete without treating pending milestones as zero", () => {
    const navigation = {
      startTime: 0,
      domainLookupStart: 2,
      domainLookupEnd: 2,
      connectStart: 2,
      connectEnd: 12,
      secureConnectionStart: 5,
      requestStart: 12,
      responseStart: 30,
      responseEnd: 40,
      domInteractive: 80,
      domContentLoadedEventEnd: 0,
      loadEventEnd: 0,
    }
    const { store, release } = fixture({ readNavigation: () => navigation })
    expect(store.getSnapshot().navigation).toEqual({
      dnsMs: 0,
      connectMs: 10,
      tlsMs: 7,
      requestMs: 18,
      responseMs: 10,
      domInteractiveMs: 80,
      domContentLoadedMs: null,
      loadMs: null,
    })
    const snapshot = store.getSnapshot()
    store.collectInterval()
    expect(store.getSnapshot()).toBe(snapshot)
    navigation.domContentLoadedEventEnd = 100
    navigation.loadEventEnd = 120
    store.collectInterval()
    expect(store.getSnapshot().navigation).toMatchObject({ domContentLoadedMs: 100, loadMs: 120 })
    store.clear()
    store.collectInterval()
    expect(store.getSnapshot().navigation).toBeNull()
    store.updateSettings({ navigation: false })
    expect(store.getSnapshot().navigation).toBeNull()
    store.updateSettings({ navigation: true })
    expect(store.getSnapshot().navigation).toMatchObject({ loadMs: 120 })
    release()
  })

  it("reports unsupported and failed groups separately and retries only after a toggle", () => {
    const createObserver = jest.fn(() => ({
      observe: () => {
        throw new Error("blocked")
      },
      disconnect: jest.fn(),
    }))
    const { store, release } = fixture({
      supportedEntryTypes: ["resource"],
      supportsFrames: false,
      createObserver,
    })
    expect(store.capabilities).toEqual(["renderer.resource"])
    expect(store.getSnapshot().errors.resources).toBe(true)
    expect(store.getSnapshot().supported.interactions).toBe(false)
    expect(store.isEnabled("resources")).toBe(false)
    expect(Object.values(store.collectInterval()).every((value) => value === null)).toBe(true)
    store.updateSettings({ navigation: false })
    expect(createObserver).toHaveBeenCalledTimes(1)
    store.updateSettings({ resources: false })
    store.updateSettings({ resources: true })
    expect(createObserver).toHaveBeenCalledTimes(2)
    release()
  })

  it("requires the Event Timing interface in addition to observer support", () => {
    const store = createRendererDiagnostics({
      supportedEntryTypes: ["event"],
      supportsEventTiming: false,
    })
    expect(store.getSnapshot().supported.interactions).toBe(false)
    expect(store.capabilities).not.toContain("renderer.event-timing")
  })

  it("reads only allowed scalar entry fields, never URLs, event names, targets, or text", () => {
    const { store, observers, release } = fixture()
    const entry = {
      startTime: 110,
      duration: 24,
      transferSize: 80,
      processingStart: 114,
      processingEnd: 118,
      get name(): never {
        throw new Error("URL or event name must not be read")
      },
      get target(): never {
        throw new Error("DOM target must not be read")
      },
      get text(): never {
        throw new Error("User content must not be read")
      },
    }
    expect(() => {
      observers[0].callback([entry])
      observers[1].callback([entry])
    }).not.toThrow()
    expect(store.collectInterval()).toMatchObject({
      "renderer.resource.count": 1,
      "renderer.event.count": 1,
    })
    release()
  })

  it("starts a fresh window after the last demand ends and excludes events from the demand gap", () => {
    const { store, observers, setNow, release } = fixture()
    const oldObserver = observers[0]
    oldObserver.callback([{ startTime: 110, duration: 20 }])
    release()
    expect(store.collectInterval()["renderer.resource.count"]).toBeNull()
    setNow(200)
    const releaseNew = store.acquire()
    oldObserver.callback([{ startTime: 201, duration: 50 }])
    observers[2].callback([
      { startTime: 199, duration: 40 },
      { startTime: 201, duration: 10 },
    ])
    expect(store.collectInterval()).toMatchObject({
      "renderer.resource.count": 1,
      "renderer.resource.duration.p95.ms": 10,
    })
    releaseNew()
  })

  it("isolates navigation read failure from the remaining collection groups", () => {
    const { store, observers, release } = fixture({
      readNavigation: () => {
        throw new Error("unavailable")
      },
    })
    expect(store.getSnapshot().errors.navigation).toBe(true)
    expect(store.getSnapshot().errors.resources).toBe(false)
    expect(store.getSnapshot().navigation).toBeNull()
    observers[0].callback([{ startTime: 110, duration: 10 }])
    expect(store.collectInterval()["renderer.resource.count"]).toBe(1)
    release()
  })

  it("does not emit plausible zero measurements for unsupported groups", () => {
    const { store, release } = fixture({ supportedEntryTypes: [], supportsFrames: false })
    expect(store.capabilities).toEqual([])
    expect(store.getSnapshot().supported).toEqual({
      resources: false,
      interactions: false,
      navigation: false,
      frames: false,
    })
    expect(Object.values(store.collectInterval()).every((value) => value === null)).toBe(true)
    release()
  })

  it("persists switches and applies cross-tab opt-out immediately", () => {
    const { store, observers, release } = fixture()
    store.updateSettings({ resources: false })
    expect(JSON.parse(localStorage.getItem(RENDERER_DIAGNOSTICS_STORAGE_KEY)!)).toMatchObject({
      enabled: true,
      resources: false,
    })
    localStorage.setItem(RENDERER_DIAGNOSTICS_STORAGE_KEY, JSON.stringify({ enabled: false }))
    window.dispatchEvent(new StorageEvent("storage", { key: RENDERER_DIAGNOSTICS_STORAGE_KEY }))
    expect(store.getSnapshot().settings.enabled).toBe(false)
    expect(observers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true)
    release()
  })

  it("keeps session opt-out effective on storage failure and fails closed on unreadable settings", () => {
    const storage = {
      getItem: jest.fn(() => {
        throw new Error("denied")
      }),
      setItem: jest.fn(() => {
        throw new Error("denied")
      }),
    }
    const store = createRendererDiagnostics({ storage })
    const release = store.acquire()
    expect(store.getSnapshot().settings.enabled).toBe(false)
    expect(store.getSnapshot().persistenceError).toBe(true)
    store.updateSettings({ enabled: true })
    expect(store.getSnapshot().settings.enabled).toBe(true)
    store.updateSettings({ enabled: false })
    expect(store.getSnapshot().settings.enabled).toBe(false)
    expect(store.getSnapshot().persistenceError).toBe(true)
    release()
  })
})
