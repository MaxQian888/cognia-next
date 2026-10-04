/** @jest-environment jsdom */

import { PERF_NAMESPACE } from "./perf-marker"
import { createRendererCollector } from "./renderer-collector"

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
