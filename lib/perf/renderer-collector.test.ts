/** @jest-environment jsdom */

import { PERF_NAMESPACE } from "./perf-marker"
import { createRendererCollector } from "./renderer-collector"
import { createRendererDiagnostics } from "./renderer-diagnostics"
import { createOperationPerformanceRecorder } from "./operation-performance"

describe("RendererPerformanceCollector", () => {
  it("uses a stable per-document source and samples only while demand exists", () => {
    const startTimer = jest.fn(() => 9 as unknown as ReturnType<typeof setInterval>)
    const stopTimer = jest.fn()
    const collector = createRendererCollector({
      documentId: "doc-a",
      timeOrigin: 123,
      now: () => 10,
      wallNow: () => 133,
      setInterval: startTimer,
      clearInterval: stopTimer,
    })
    expect(collector.source.sourceId).toBe("renderer:doc-a")
    expect(startTimer).not.toHaveBeenCalled()

    const lease = collector.openDemand({ purpose: "live", cadenceMs: 1000 })
    expect(startTimer).toHaveBeenCalledTimes(1)
    collector.closeDemand(lease)
    expect(stopTimer).toHaveBeenCalledWith(9)
  })

  it("keeps User Timing data in a bounded collector without clearing the global timeline", () => {
    const clearMeasures = jest.fn()
    Object.defineProperty(performance, "clearMeasures", {
      configurable: true,
      value: clearMeasures,
    })
    const collector = createRendererCollector({
      documentId: "doc-a",
      timeOrigin: 0,
      now: () => 0,
      wallNow: () => 0,
    })
    for (let index = 0; index < 70; index += 1) {
      collector.ingestPerformanceEntries([
        {
          name: `${PERF_NAMESPACE}chat-turn`,
          duration: index,
          startTime: index,
          entryType: "measure",
        },
      ])
    }
    expect(collector.getMeasurements().get(`${PERF_NAMESPACE}chat-turn`)).toHaveLength(60)
    expect(clearMeasures).not.toHaveBeenCalled()
  })

  it("emits actual elapsed time, sequence identity, and explicit missed ticks", () => {
    let now = 0
    const collector = createRendererCollector({
      documentId: "doc-a",
      timeOrigin: 1000,
      now: () => now,
      wallNow: () => 1000 + now,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
    })
    collector.setScope({ targetId: "target-a", routingGeneration: 2 })
    collector.openDemand({ purpose: "capture", cadenceMs: 500 })
    now = 1250
    const frame = collector.collectNow()
    expect(frame).toMatchObject({
      sourceId: "renderer:doc-a",
      targetId: "target-a",
      routingGeneration: 2,
      sequence: 1,
      requestedIntervalMs: 500,
      actualIntervalMs: 1250,
      missedTicks: 1,
    })
  })

  it("reports each observed entry in only one sampling interval", () => {
    const collector = createRendererCollector({
      documentId: "doc-a",
      timeOrigin: 0,
      now: () => 0,
      wallNow: () => 0,
      supportedEntryTypes: ["measure", "longtask"],
    })
    collector.ingestPerformanceEntries([
      {
        name: "long-task",
        duration: 25,
        startTime: 1,
        entryType: "longtask",
      },
      {
        name: `${PERF_NAMESPACE}chat-turn`,
        duration: 10,
        startTime: 2,
        entryType: "measure",
      },
    ])

    expect(collector.collectNow().observations).toMatchObject({
      "renderer.long-task.count": 1,
      "renderer.long-task.total-ms": 25,
      "renderer.user-timing.count": 1,
    })
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.long-task.count": 0,
      "renderer.long-task.total-ms": 0,
      "renderer.user-timing.count": 0,
    })
    expect(collector.getMeasurements().get(`${PERF_NAMESPACE}chat-turn`)).toHaveLength(1)
  })

  it("preserves interval totals beyond the bounded detail history and measures blocking excess", () => {
    const collector = createRendererCollector({ supportedEntryTypes: ["longtask"], readHeap: null })
    collector.ingestPerformanceEntries(
      Array.from({ length: 100 }, (_, index) => ({
        name: "long-task",
        entryType: "longtask",
        duration: 80,
        startTime: index * 80,
      }))
    )
    expect(collector.getMeasurements().get("renderer:long-task")).toHaveLength(60)
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.long-task.count": 100,
      "renderer.long-task.total-ms": 8000,
      "renderer.long-task.max.ms": 80,
      "renderer.long-task.blocking.ms": 3000,
    })
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.long-task.count": 0,
      "renderer.long-task.max.ms": null,
      "renderer.long-task.blocking.ms": 0,
    })
  })

  it("rejects invalid durations and reports heap utilization only for valid limits", () => {
    let heap = { usedJSHeapSize: 25, jsHeapSizeLimit: 100 }
    const collector = createRendererCollector({
      supportedEntryTypes: ["longtask"],
      readHeap: () => heap,
    })
    collector.ingestPerformanceEntries([
      { name: "long-task", entryType: "longtask", duration: NaN, startTime: 1 },
      { name: "long-task", entryType: "longtask", duration: -1, startTime: 1 },
    ])
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.long-task.count": 0,
      "renderer.js-heap.utilization.pct": 25,
    })
    heap = { usedJSHeapSize: 25, jsHeapSizeLimit: 0 }
    expect(collector.collectNow().observations?.["renderer.js-heap.utilization.pct"]).toBeNull()
  })

  it("advertises only the capabilities this engine can measure", () => {
    const webkit = createRendererCollector({
      documentId: "doc-w",
      requestAnimationFrame: null,
      readHeap: null,
      supportedEntryTypes: ["measure"],
    })
    expect(webkit.source.capabilities).toEqual(["renderer.user-timing", "renderer.chat-latency"])

    const chromium = createRendererCollector({
      documentId: "doc-c",
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      readHeap: () => ({ usedJSHeapSize: 1, jsHeapSizeLimit: 2 }),
      supportedEntryTypes: ["measure", "longtask"],
    })
    expect(chromium.source.capabilities).toEqual([
      "renderer.fps",
      "renderer.long-task",
      "renderer.user-timing",
      "renderer.chat-latency",
      "renderer.js-heap",
      "renderer.frame-timing",
    ])
  })

  it("reports unmeasured observations as null rather than zero", () => {
    const collector = createRendererCollector({
      documentId: "doc-w",
      now: () => 0,
      wallNow: () => 0,
      requestAnimationFrame: null,
      readHeap: null,
      supportedEntryTypes: ["measure"],
    })
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.fps": null,
      "renderer.long-task.count": null,
      "renderer.main-thread-blocked.pct": null,
      "renderer.js-heap.used.bytes": null,
    })
  })

  it("counts frame callbacks only while sampling, and derives FPS, blocking and heap", () => {
    let now = 0
    const callbacks: Array<() => void> = []
    const cancel = jest.fn()
    const collector = createRendererCollector({
      documentId: "doc-c",
      now: () => now,
      wallNow: () => now,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
      requestAnimationFrame: (callback) => {
        callbacks.push(callback)
        return callbacks.length
      },
      cancelAnimationFrame: cancel,
      readHeap: () => ({ usedJSHeapSize: 4096, jsHeapSizeLimit: 8192 }),
      supportedEntryTypes: ["measure", "longtask"],
      bufferedMeasures: () => [],
      isHidden: () => false,
    })
    expect(callbacks).toHaveLength(0)
    const demand = collector.openDemand({ purpose: "live", cadenceMs: 1000 })
    // 30 frames painted over a 500 ms interval → 60 fps.
    for (let index = 0; index < 30; index += 1) callbacks[callbacks.length - 1]()
    collector.ingestPerformanceEntries([
      { name: "long-task", duration: 100, startTime: 1, entryType: "longtask" },
    ])
    now = 500
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.fps": 60,
      "renderer.main-thread-blocked.pct": 20,
      "renderer.js-heap.used.bytes": 4096,
      "renderer.js-heap.limit.bytes": 8192,
    })
    collector.closeDemand(demand)
    expect(cancel).toHaveBeenCalled()
  })

  it("treats a hidden document's frame rate as unmeasured", () => {
    let now = 0
    const collector = createRendererCollector({
      documentId: "doc-h",
      now: () => now,
      wallNow: () => now,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      readHeap: null,
      supportedEntryTypes: ["measure"],
      isHidden: () => true,
    })
    now = 1000
    expect(collector.collectNow().observations?.["renderer.fps"]).toBeNull()
  })

  it("collects frame gaps only with opt-in demand and resets across visibility or toggles", () => {
    let now = 0
    let hidden = false
    let tick = () => {}
    let visibilityChanged = () => {}
    const diagnostics = createRendererDiagnostics({
      storage: { getItem: () => null, setItem: () => {} },
      supportedEntryTypes: [],
      supportsFrames: true,
    })
    const collector = createRendererCollector({
      now: () => now,
      wallNow: () => now,
      diagnostics,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
      requestAnimationFrame: (cb) => {
        tick = cb
        return 1
      },
      cancelAnimationFrame: () => {},
      isHidden: () => hidden,
      subscribeVisibility: (callback) => {
        visibilityChanged = callback
        return () => {}
      },
    })
    const lease = collector.openDemand({ purpose: "live", cadenceMs: 1000 })
    tick()
    expect(collector.collectNow().observations?.["renderer.frame-gap.p95.ms"]).toBeNull()
    diagnostics.updateSettings({ enabled: true })
    now = 10
    tick()
    now = 30
    tick()
    now = 100
    tick()
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.frame-gap.p95.ms": 67.5,
      "renderer.slow-frame.count": 1,
    })
    hidden = true
    visibilityChanged()
    now = 10000
    hidden = false
    visibilityChanged()
    tick()
    expect(collector.collectNow().observations?.["renderer.frame-gap.p95.ms"]).toBeNull()
    now = 10020
    tick()
    diagnostics.updateSettings({ frames: false })
    diagnostics.updateSettings({ frames: true })
    now = 11000
    tick()
    expect(collector.collectNow().observations?.["renderer.frame-gap.p95.ms"]).toBeNull()
    collector.closeDemand(lease)
  })

  it("shares one optional observer lease across live and capture consumers", () => {
    const diagnostics = createRendererDiagnostics({
      supportedEntryTypes: [],
      supportsFrames: false,
    })
    const acquire = jest.spyOn(diagnostics, "acquire")
    const collector = createRendererCollector({
      diagnostics,
      requestAnimationFrame: null,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
    })
    const live = collector.openDemand({ purpose: "live", cadenceMs: 1000 })
    const capture = collector.openDemand({ purpose: "capture", cadenceMs: 500 })
    expect(acquire).toHaveBeenCalledTimes(1)
    collector.closeDemand(live)
    collector.closeDemand(capture)
    const next = collector.openDemand({ purpose: "live", cadenceMs: 1000 })
    expect(acquire).toHaveBeenCalledTimes(2)
    collector.closeDemand(next)
  })

  it("feeds optional resource samples into the same frames used by captures", () => {
    let now = 0
    let deliver: (
      entries: { startTime: number; duration: number; transferSize: number }[]
    ) => void = () => {}
    const disconnect = jest.fn()
    const diagnostics = createRendererDiagnostics({
      now: () => now,
      supportedEntryTypes: ["resource"],
      supportsFrames: false,
      storage: { getItem: () => JSON.stringify({ enabled: true }), setItem: () => {} },
      createObserver: (callback) => {
        deliver = callback
        return { observe: () => {}, disconnect }
      },
    })
    const collector = createRendererCollector({
      diagnostics,
      requestAnimationFrame: null,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
    })
    const lease = collector.openDemand({ purpose: "capture", cadenceMs: 1000 })
    expect(collector.source.capabilities).toContain("renderer.resource")
    now = 100
    deliver([{ startTime: 10, duration: 80, transferSize: 500 }])
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.resource.count": 1,
      "renderer.resource.duration.p95.ms": 80,
      "renderer.resource.transfer.bytes": 500,
    })
    deliver([{ startTime: 20, duration: 50, transferSize: 500 }])
    const staleDeliver = deliver
    collector.setScope({ targetId: "new-host", routingGeneration: 2 })
    staleDeliver([{ startTime: 21, duration: 55, transferSize: 500 }])
    expect(collector.collectNow()).toMatchObject({
      targetId: "new-host",
      routingGeneration: 2,
      observations: { "renderer.resource.count": 0, "renderer.resource.duration.p95.ms": null },
    })
    collector.closeDemand(lease)
    expect(disconnect).toHaveBeenCalledTimes(2)
    deliver([{ startTime: 100, duration: 99, transferSize: 200 }])
    expect(collector.collectNow().observations?.["renderer.resource.count"]).toBeNull()
  })

  it("does not restart a stopped animation loop from an already queued callback", () => {
    let callback = () => {}
    const request = jest.fn((cb: () => void) => {
      callback = cb
      return 1
    })
    const collector = createRendererCollector({
      requestAnimationFrame: request,
      cancelAnimationFrame: () => {},
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
    })
    const lease = collector.openDemand({ purpose: "live", cadenceMs: 1000 })
    collector.closeDemand(lease)
    callback()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("keeps slow-frame counts exact but hides p95 when the interval exceeds its sample bound", () => {
    let now = 0
    let tick = () => {}
    const diagnostics = createRendererDiagnostics({
      supportsFrames: true,
      supportedEntryTypes: [],
      storage: { getItem: () => JSON.stringify({ enabled: true }), setItem: () => {} },
    })
    const collector = createRendererCollector({
      diagnostics,
      now: () => now,
      isHidden: () => false,
      requestAnimationFrame: (callback) => {
        tick = callback
        return 1
      },
      cancelAnimationFrame: () => {},
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
    })
    const lease = collector.openDemand({ purpose: "live", cadenceMs: 1000 })
    for (let index = 0; index < 502; index++) {
      now += 60
      tick()
    }
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.frame-gap.p95.ms": null,
      "renderer.slow-frame.count": 501,
    })
    collector.closeDemand(lease)
  })

  it("seeds measures written before sampling began, once, and honours a clear", () => {
    let now = 0
    const buffered = [
      { name: `${PERF_NAMESPACE}chat:turn`, duration: 120, startTime: 5, entryType: "measure" },
      { name: "unrelated", duration: 1, startTime: 6, entryType: "measure" },
    ]
    const collector = createRendererCollector({
      documentId: "doc-s",
      now: () => now,
      wallNow: () => now,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
      requestAnimationFrame: null,
      readHeap: null,
      supportedEntryTypes: ["measure"],
      bufferedMeasures: () => buffered,
    })
    const first = collector.openDemand({ purpose: "live", cadenceMs: 1000 })
    expect(collector.getMeasurements().get(`${PERF_NAMESPACE}chat:turn`)).toHaveLength(1)
    expect(collector.getMeasurements().has("unrelated")).toBe(false)
    // Seeded entries belong to no live interval.
    expect(collector.collectNow().observations?.["renderer.user-timing.count"]).toBe(0)

    // Re-opening after the last demand closed re-seeds without duplicating.
    collector.closeDemand(first)
    const second = collector.openDemand({ purpose: "live", cadenceMs: 1000 })
    expect(collector.getMeasurements().get(`${PERF_NAMESPACE}chat:turn`)).toHaveLength(1)

    // A clear is not undone by the next seed.
    now = 10
    collector.clearMeasurements()
    collector.closeDemand(second)
    collector.openDemand({ purpose: "live", cadenceMs: 1000 })
    expect(collector.getMeasurements().size).toBe(0)
  })
})

describe("default heap reader", () => {
  it("reads MemoryInfo's getter fields rather than spreading them", () => {
    class MemoryInfo {
      get usedJSHeapSize() {
        return 1234
      }
      get jsHeapSizeLimit() {
        return 5678
      }
    }
    const original = Object.getOwnPropertyDescriptor(performance, "memory")
    Object.defineProperty(performance, "memory", { configurable: true, value: new MemoryInfo() })
    try {
      const collector = createRendererCollector({
        documentId: "doc-m",
        now: () => 0,
        wallNow: () => 0,
        requestAnimationFrame: null,
        supportedEntryTypes: ["measure"],
      })
      expect(collector.source.capabilities).toContain("renderer.js-heap")
      expect(collector.collectNow().observations).toMatchObject({
        "renderer.js-heap.used.bytes": 1234,
        "renderer.js-heap.limit.bytes": 5678,
      })
    } finally {
      if (original) Object.defineProperty(performance, "memory", original)
      else delete (performance as { memory?: unknown }).memory
    }
  })
})

describe("operation performance sampling", () => {
  function fixture() {
    let now = 0
    const operations = createOperationPerformanceRecorder({
      isBrowser: () => true,
      clock: () => now,
      storage: { getItem: () => null, setItem: () => {} },
    })
    const collector = createRendererCollector({
      operations,
      now: () => now,
      wallNow: () => now,
      requestAnimationFrame: null,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
    })
    return {
      operations,
      collector,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  it("advertises operation sampling only for an injected recorder and keeps disabled values null", () => {
    expect(createRendererCollector().source.capabilities).not.toContain("renderer.app-operations")
    const { collector } = fixture()
    expect(collector.source.capabilities).toContain("renderer.app-operations")
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.operation.count": null,
      "renderer.operation.duration.p95.ms": null,
      "renderer.operation.error.count": null,
      "renderer.operation.inflight.count": null,
    })
  })

  it("drains completion intervals while retaining inflight work and cumulative rows", () => {
    const { operations, collector, advance } = fixture()
    operations.updateSettings({ enabled: true })
    const lease = collector.openDemand({ purpose: "capture", cadenceMs: 1000 })
    const success = operations.begin("storage.messages.load")
    const failure = operations.begin("storage.messages.load")
    const pending = operations.begin("storage.messages.load")
    advance(10)
    success()
    advance(10)
    failure("error")
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.operation.count": 2,
      "renderer.operation.duration.p95.ms": 19.5,
      "renderer.operation.error.count": 1,
      "renderer.operation.inflight.count": 1,
    })
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.operation.count": 0,
      "renderer.operation.duration.p95.ms": null,
      "renderer.operation.error.count": 0,
      "renderer.operation.inflight.count": 1,
    })
    expect(
      operations.getSnapshot().rows.find((row) => row.name === "storage.messages.load")
    ).toMatchObject({ count: 2, errors: 1, inFlight: 1 })
    pending("cancelled")
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.operation.count": 1,
      "renderer.operation.cancelled.count": 1,
      "renderer.operation.inflight.count": 0,
    })
    collector.closeDemand(lease)
  })

  it("excludes idle completions on first and restarted demand without discarding cumulative history", () => {
    const { operations, collector } = fixture()
    operations.updateSettings({ enabled: true })
    operations.begin("storage.sessions.list")()
    let lease = collector.openDemand({ purpose: "live", cadenceMs: 1000 })
    expect(collector.collectNow().observations?.["renderer.operation.count"]).toBe(0)
    collector.closeDemand(lease)
    operations.begin("storage.sessions.list")()
    const pending = operations.begin("storage.sessions.list")
    lease = collector.openDemand({ purpose: "live", cadenceMs: 1000 })
    expect(collector.collectNow().observations).toMatchObject({
      "renderer.operation.count": 0,
      "renderer.operation.inflight.count": 1,
    })
    expect(
      operations.getSnapshot().rows.find((row) => row.name === "storage.sessions.list")
    ).toMatchObject({ count: 2, inFlight: 1 })
    pending()
    const additional = collector.openDemand({ purpose: "capture", cadenceMs: 500 })
    expect(collector.collectNow().observations?.["renderer.operation.count"]).toBe(1)
    collector.closeDemand(additional)
    collector.closeDemand(lease)
  })

  it("drops old interval completions when routing scope changes", () => {
    const { operations, collector } = fixture()
    operations.updateSettings({ enabled: true })
    const lease = collector.openDemand({ purpose: "capture", cadenceMs: 1000 })
    operations.begin("transport.local.call")()
    collector.setScope({ targetId: "remote-host", routingGeneration: 2 })
    expect(collector.collectNow().observations?.["renderer.operation.count"]).toBe(0)
    expect(
      operations.getSnapshot().rows.find((row) => row.name === "transport.local.call")
    ).toMatchObject({ count: 1 })
    collector.closeDemand(lease)
  })
})
