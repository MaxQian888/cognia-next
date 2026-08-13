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
})
