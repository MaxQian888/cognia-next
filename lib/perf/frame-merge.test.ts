import { PERF_WIRE_VERSION, type PerfFrame, type PerfSnapshot } from "./backend/types"
import { mergePerfFrames } from "./frame-merge"

const makeFrame = (sequence: number, overrides: Partial<PerfFrame> = {}): PerfFrame => ({
  wireVersion: PERF_WIRE_VERSION,
  sourceId: "host:one",
  targetId: "target-a",
  routingGeneration: 4,
  hostInstanceId: "boot-a",
  samplingSessionId: "sample-a",
  sequence,
  requestedIntervalMs: 1000,
  actualIntervalMs: 1000,
  monotonicElapsedMs: 1000,
  wallStartMs: sequence * 1000,
  wallEndMs: sequence * 1000 + 1000,
  collectionDurationMs: 5,
  missedTicks: 0,
  flags: { reset: false, discontinuity: false, counterReset: false, sourceRestarted: false },
  tsMs: sequence * 1000 + 1000,
  intervalMs: 1000,
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
  ...overrides,
})

const snapshot = (frames: PerfFrame[]): PerfSnapshot => ({
  wireVersion: PERF_WIRE_VERSION,
  frames,
  oldestSequence: frames[0]?.sequence ?? null,
  latestSequence: frames.at(-1)?.sequence ?? null,
  sources: [],
  leases: [],
  gaps: [],
  samples: frames,
  running: true,
  intervalMs: 1000,
})

describe("mergePerfFrames", () => {
  it("merges events buffered before the snapshot and de-duplicates identities", () => {
    const merged = mergePerfFrames(
      snapshot([makeFrame(1), makeFrame(2)]),
      [makeFrame(2), makeFrame(3)],
      { targetId: "target-a", routingGeneration: 4 }
    )
    expect(merged.frames.map((frame) => frame.sequence)).toEqual([1, 2, 3])
    expect(merged.gaps).toEqual([])
  })

  it("rejects late frames from the old target and routing generation", () => {
    const merged = mergePerfFrames(
      snapshot([makeFrame(1)]),
      [
        makeFrame(2, { targetId: "target-old" }),
        makeFrame(3, { routingGeneration: 3 }),
        makeFrame(4),
      ],
      { targetId: "target-a", routingGeneration: 4 }
    )
    expect(merged.frames.map((frame) => frame.sequence)).toEqual([1, 4])
  })

  it("records sequence holes instead of manufacturing zero-valued frames", () => {
    const merged = mergePerfFrames(snapshot([makeFrame(10)]), [makeFrame(13)], {
      targetId: "target-a",
      routingGeneration: 4,
    })
    expect(merged.frames.map((frame) => frame.sequence)).toEqual([10, 13])
    expect(merged.gaps).toEqual([
      expect.objectContaining({
        reason: "sequence-gap",
        sequenceStart: 11,
        sequenceEnd: 12,
        recoverable: true,
      }),
    ])
  })
})
