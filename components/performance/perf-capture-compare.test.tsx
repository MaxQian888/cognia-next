/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PERF_WIRE_VERSION, type PerfFrame } from "@/lib/perf/backend/types"
import type { DecodedCapture } from "@/lib/perf/capture-analysis"
import type { PerformanceCaptureRow } from "@/lib/perf/capture-types"
import { PerfCaptureCompare } from "./perf-capture-compare"

function row(id: string, startedAt: number, frames = 20): PerformanceCaptureRow {
  return {
    id,
    status: "ready",
    purpose: "capture",
    sourceKind: "renderer",
    sourceId: "renderer:doc",
    hostInstanceId: "doc",
    targetId: "t",
    routingGeneration: 0,
    wireVersion: 1,
    metricSchemaVersion: 1,
    capabilityBits: "",
    startedAt,
    updatedAt: startedAt + frames * 1000,
    stoppedAt: startedAt + frames * 1000,
    pinned: 0,
    payloadBytes: 0,
    attachmentBytes: 0,
    frameCount: frames,
    gapCount: 0,
    environmentDigest: "env",
  }
}

function frames(fps: number, count = 20): PerfFrame[] {
  return Array.from({ length: count }, (_, index) => ({
    wireVersion: PERF_WIRE_VERSION,
    sourceId: "renderer:doc",
    targetId: "t",
    routingGeneration: 0,
    hostInstanceId: "doc",
    samplingSessionId: "session",
    sequence: index + 1,
    requestedIntervalMs: 1000,
    actualIntervalMs: 1000,
    monotonicElapsedMs: 1000,
    wallStartMs: index * 1000,
    wallEndMs: (index + 1) * 1000,
    collectionDurationMs: 1,
    missedTicks: 0,
    flags: { reset: false, discontinuity: false, counterReset: false, sourceRestarted: false },
    tsMs: 0,
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
    observations: { "renderer.fps": fps },
  }))
}

const older = row("older", 1_000)
const newer = row("newer", 5_000_000)

function loader(captures: Record<string, DecodedCapture>) {
  return jest.fn(async (id: string) => {
    const decoded = captures[id]
    if (!decoded) throw new Error("performance-capture-not-found")
    return decoded
  })
}

describe("PerfCaptureCompare", () => {
  it("uses the older capture as the baseline and lets the user swap", () => {
    render(
      <PerfCaptureCompare
        captures={[newer, older]}
        loadCapture={loader({})}
        describeError={String}
      />
    )
    expect(screen.getByTestId("perf-compare-baseline")).toHaveTextContent("older")
    fireEvent.click(screen.getByTestId("perf-compare-swap"))
    expect(screen.getByTestId("perf-compare-baseline")).toHaveTextContent("newer")
  })

  it("reports an eligible comparison with a direction-aware delta", async () => {
    const loadCapture = loader({
      older: { row: older, frames: frames(60), metadata: null },
      newer: { row: newer, frames: frames(45), metadata: null },
    })
    render(
      <PerfCaptureCompare
        captures={[older, newer]}
        loadCapture={loadCapture}
        describeError={String}
      />
    )
    fireEvent.click(screen.getByTestId("perf-compare-run"))
    await screen.findByTestId("perf-compare-result")
    expect(screen.getByTestId("perf-compare-eligibility")).toHaveAttribute("data-eligible", "true")
    // FPS: higher is better, so a drop is worse.
    expect(screen.getByTestId("perf-compare-delta")).toHaveAttribute("data-tone", "worse")
    expect(screen.getByTestId("perf-compare-delta")).toHaveTextContent("−15 fps")
  })

  it("lists why a pair is not comparable", async () => {
    const short = row("newer", 5_000_000, 5)
    const loadCapture = loader({
      older: { row: older, frames: frames(60), metadata: null },
      newer: { row: short, frames: frames(45, 5), metadata: null },
    })
    render(
      <PerfCaptureCompare
        captures={[older, short]}
        loadCapture={loadCapture}
        describeError={String}
      />
    )
    fireEvent.click(screen.getByTestId("perf-compare-run"))
    await screen.findByTestId("perf-compare-result")
    expect(screen.getByTestId("perf-compare-eligibility")).toHaveAttribute("data-eligible", "false")
    expect(screen.getByTestId("perf-compare-reason-minimum-valid-intervals")).toBeInTheDocument()
  })

  it("warns about mixed sources and shows load errors", async () => {
    const host = { ...newer, sourceKind: "host" as const }
    render(
      <PerfCaptureCompare
        captures={[older, host]}
        loadCapture={loader({})}
        describeError={(error) => `failed: ${(error as Error).message}`}
      />
    )
    expect(screen.getByTestId("perf-compare-source-warning")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("perf-compare-run"))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("failed: performance-capture-not-found")
    )
  })
})
