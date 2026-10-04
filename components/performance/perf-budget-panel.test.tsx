/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PERF_WIRE_VERSION, type PerfFrame } from "@/lib/perf/backend/types"
import type { PerformanceBudgetProfile } from "@/lib/perf/budget-service"
import type { PerformanceCaptureRow } from "@/lib/perf/capture-types"

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

import { budgetDraftToInput, PerfBudgetPanel, type PerfBudgetStore } from "./perf-budget-panel"

const BUDGET: PerformanceBudgetProfile = {
  id: "b1",
  name: "Smooth chat",
  version: 1,
  immutable: true,
  metricId: "renderer.fps",
  metricDefinitionVersion: 1,
  unit: "fps",
  sourceKind: "renderer",
  metricSchemaVersion: 1,
  requestedCadenceMs: 1000,
  aggregation: "median",
  direction: "higher",
  warningThreshold: 50,
  failureThreshold: 30,
  applicability: { runtimeKinds: ["browser"], buildProfiles: ["production"] },
  comparisonWindow: "interval",
  createdAt: 0,
}

const CAPTURE: PerformanceCaptureRow = {
  id: "c1",
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
  startedAt: 0,
  updatedAt: 20_000,
  stoppedAt: 20_000,
  pinned: 0,
  payloadBytes: 0,
  attachmentBytes: 0,
  frameCount: 20,
  gapCount: 0,
}

function frames(fps: number): PerfFrame[] {
  return Array.from({ length: 20 }, (_, index) => ({
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

function makeStore(initial: PerformanceBudgetProfile[] = [BUDGET]): PerfBudgetStore & {
  created: unknown[]
} {
  const budgets = [...initial]
  const created: unknown[] = []
  return {
    created,
    list: jest.fn(async () => [...budgets]),
    create: jest.fn(async (input) => {
      created.push(input)
      const profile = {
        ...BUDGET,
        ...input,
        id: `b${budgets.length + 1}`,
      } as PerformanceBudgetProfile
      budgets.push(profile)
      return profile
    }),
  }
}

describe("PerfBudgetPanel", () => {
  it("explains that budgets need an unlocked account", () => {
    render(
      <PerfBudgetPanel store={null} captures={[]} loadCapture={jest.fn()} describeError={String} />
    )
    expect(screen.getByTestId("perf-budget-locked")).toBeInTheDocument()
    expect(screen.getByTestId("perf-budget-new")).toBeDisabled()
  })

  it("lists budgets with their thresholds and applicability", async () => {
    render(
      <PerfBudgetPanel
        store={makeStore()}
        captures={[CAPTURE]}
        loadCapture={jest.fn()}
        describeError={String}
      />
    )
    const item = await screen.findByTestId("perf-budget-b1")
    expect(item).toHaveTextContent("Smooth chat")
    expect(item).toHaveTextContent("Frame rate")
    expect(item).toHaveTextContent("warn 50 fps")
    expect(item).toHaveTextContent("Browser")
  })

  it("checks a capture and shows the verdict with its evidence", async () => {
    const loadCapture = jest.fn(async () => ({ row: CAPTURE, frames: frames(40), metadata: null }))
    render(
      <PerfBudgetPanel
        store={makeStore()}
        captures={[CAPTURE]}
        loadCapture={loadCapture}
        describeError={String}
      />
    )
    await screen.findByTestId("perf-budget-b1")
    // No metadata → environment unknown → not comparable until accepted.
    fireEvent.click(screen.getByTestId("perf-budget-check-run"))
    const verdict = await screen.findByTestId("perf-budget-verdict")
    expect(verdict).toHaveAttribute("data-verdict", "incomparable")
    expect(verdict).toHaveTextContent("runtime or build")

    fireEvent.click(screen.getByRole("checkbox", { name: /Accept a different environment/ }))
    fireEvent.click(screen.getByTestId("perf-budget-check-run"))
    await waitFor(() =>
      expect(screen.getByTestId("perf-budget-verdict")).toHaveAttribute("data-verdict", "warn")
    )
    expect(screen.getByTestId("perf-budget-verdict")).toHaveTextContent("40 fps over 20 of 20")
  })

  it("creates a budget from the dialog and refreshes the list", async () => {
    const store = makeStore([])
    render(
      <PerfBudgetPanel store={store} captures={[]} loadCapture={jest.fn()} describeError={String} />
    )
    await screen.findByTestId("perf-budget-empty")
    fireEvent.click(screen.getByTestId("perf-budget-new"))
    fireEvent.change(await screen.findByTestId("perf-budget-name"), {
      target: { value: "Smooth" },
    })
    // Frame rate is higher-is-better: warning 30 below failure 50 is refused.
    fireEvent.change(screen.getByTestId("perf-budget-warning"), { target: { value: "30" } })
    fireEvent.change(screen.getByTestId("perf-budget-failure"), { target: { value: "50" } })
    fireEvent.click(screen.getByTestId("perf-budget-save"))
    expect(await screen.findByTestId("perf-budget-error")).toHaveTextContent("at or above")

    fireEvent.change(screen.getByTestId("perf-budget-warning"), { target: { value: "50" } })
    fireEvent.change(screen.getByTestId("perf-budget-failure"), { target: { value: "30" } })
    fireEvent.click(screen.getByTestId("perf-budget-save"))
    await waitFor(() => expect(store.create).toHaveBeenCalledTimes(1))
    expect(store.created[0]).toMatchObject({
      name: "Smooth",
      metricId: "renderer.fps",
      warningThreshold: 50,
      failureThreshold: 30,
      direction: "higher",
    })
    expect(await screen.findByTestId("perf-budget-b1")).toBeInTheDocument()
    expect(toastSuccess).toHaveBeenCalledWith("Budget “Smooth” created.")
  })
})

describe("budgetDraftToInput", () => {
  const draft = {
    name: "Memory",
    sourceKind: "host" as const,
    metricId: "host.main.memory-bytes" as const,
    aggregation: "p95" as const,
    warning: "512",
    failure: "1024",
    cadenceMs: 2000,
    runtimeKinds: ["tauri-rust" as const],
    buildProfiles: ["production" as const],
  }

  it("converts MB thresholds to bytes and pins the metric definition", () => {
    const result = budgetDraftToInput(draft)
    expect("input" in result && result.input).toMatchObject({
      unit: "bytes",
      warningThreshold: 512 * 1024 * 1024,
      failureThreshold: 1024 * 1024 * 1024,
      requestedCadenceMs: 2000,
      metricDefinitionVersion: 1,
      metricSchemaVersion: 1,
      comparisonWindow: "interval",
    })
  })

  it("rejects incomplete or inconsistent drafts", () => {
    expect(budgetDraftToInput({ ...draft, name: " " })).toEqual({ error: "name" })
    expect(budgetDraftToInput({ ...draft, warning: "" })).toEqual({ error: "thresholds" })
    expect(budgetDraftToInput({ ...draft, warning: "2048" })).toEqual({ error: "order.lower" })
    expect(budgetDraftToInput({ ...draft, runtimeKinds: [] })).toEqual({ error: "runtimeKinds" })
    expect(budgetDraftToInput({ ...draft, buildProfiles: [] })).toEqual({ error: "buildProfiles" })
    expect(budgetDraftToInput({ ...draft, sourceKind: "renderer" })).toEqual({ error: "metric" })
  })
})
