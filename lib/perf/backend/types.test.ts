import { PERF_WIRE_VERSION, type PerfFrame, type PerfSnapshot } from "./types"

function frame(sequence: number): PerfFrame {
  return {
    wireVersion: PERF_WIRE_VERSION,
    sourceId: "renderer:doc-1",
    targetId: "web-standalone",
    routingGeneration: 1,
    hostInstanceId: "doc-1",
    samplingSessionId: "session-1",
    sequence,
    requestedIntervalMs: 1000,
    actualIntervalMs: 1004,
    monotonicElapsedMs: 1004,
    wallStartMs: 1000,
    wallEndMs: 2004,
    collectionDurationMs: 4,
    missedTicks: 0,
    flags: {
      reset: false,
      discontinuity: false,
      counterReset: false,
      sourceRestarted: false,
    },
    tsMs: 2004,
    intervalMs: 1004,
    processes: [],
    runtime: {
      workers: 0,
      aliveTasks: 0,
      globalQueueDepth: 0,
      blockingThreads: 0,
      blockingQueueDepth: 0,
      spawnedTasksCount: 0,
      budgetForcedYieldCount: 0,
      workerStealCount: 0,
      workerParkCount: 0,
      workerOverflowCount: 0,
      busyPct: 0,
      perWorkerBusyPct: [],
    },
    topSpans: [],
    systemMemory: null,
    managed: [],
  }
}

describe("performance wire model", () => {
  it("keeps version, source/session identity, actual elapsed time, and gap state explicit", () => {
    const first = frame(7)
    const snapshot: PerfSnapshot = {
      wireVersion: PERF_WIRE_VERSION,
      frames: [first],
      oldestSequence: 7,
      latestSequence: 7,
      sources: [],
      leases: [],
      gaps: [],
      samples: [first],
      running: true,
      intervalMs: 1000,
    }

    expect(snapshot.wireVersion).toBe(1)
    expect(snapshot.frames[0]).toMatchObject({
      sourceId: "renderer:doc-1",
      samplingSessionId: "session-1",
      actualIntervalMs: 1004,
      monotonicElapsedMs: 1004,
    })
    expect(snapshot.gaps).toEqual([])
  })
})
