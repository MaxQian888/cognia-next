/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"

const usePerfStreamMock = jest.fn()
jest.mock("@/hooks/perf/use-perf-stream", () => ({
  usePerfStream: () => usePerfStreamMock(),
  PERF_INTERVAL_OPTIONS: [500, 1000, 2000, 4000],
}))

// Stateful Tabs stub: Radix activates on focus (not click) which is flaky in
// jsdom, so model a click-driven controlled tab set that renders only the
// active content — deterministic and preserves the trigger data-testids.
jest.mock("@/components/ui/tabs", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react")
  const Ctx = ReactLib.createContext({ value: "", setValue: (_v: string) => {} })
  return {
    Tabs: ({ children, defaultValue }: { children: React.ReactNode; defaultValue: string }) => {
      const [value, setValue] = ReactLib.useState(defaultValue)
      return ReactLib.createElement(Ctx.Provider, { value: { value, setValue } }, children)
    },
    TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    TabsTrigger: ({ children, value, ...rest }: { children: React.ReactNode; value: string }) => {
      const ctx = ReactLib.useContext(Ctx)
      return (
        <button {...rest} onClick={() => ctx.setValue(value)}>
          {children}
        </button>
      )
    },
    TabsContent: ({ children, value }: { children: React.ReactNode; value: string }) => {
      const ctx = ReactLib.useContext(Ctx)
      return ctx.value === value ? <div>{children}</div> : null
    },
  }
})

const exportPerfSnapshotMock = jest.fn((..._args: unknown[]) => ({
  filename: "cognia-perf-snapshot-x.json",
  mime: "application/json",
}))
jest.mock("@/lib/perf/backend/export", () => ({
  exportPerfSnapshot: (...a: unknown[]) => exportPerfSnapshotMock(...a),
}))
const toastSuccessMock = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccessMock(...a) } }))

jest.mock("./perf-toolbar", () => ({
  PerfToolbar: ({ onExport }: { onExport: (f: string) => void }) => (
    <button data-testid="toolbar" onClick={() => onExport("json")} />
  ),
}))
jest.mock("./perf-overview-tab", () => ({ PerfOverviewTab: () => <div data-testid="overview" /> }))
jest.mock("./perf-process-table", () => ({ PerfProcessTable: () => <div data-testid="proc" /> }))
jest.mock("./perf-hotspots-table", () => ({ PerfHotspotsTable: () => <div data-testid="hot" /> }))
jest.mock("./perf-runtime-tab", () => ({ PerfRuntimeTab: () => <div data-testid="rt" /> }))

import { PerformanceDashboard } from "./performance-dashboard"

const baseState = {
  history: [],
  latest: null,
  paused: false,
  intervalMs: 1000,
  setPaused: jest.fn(),
  setIntervalMs: jest.fn(),
  reset: jest.fn(),
}

beforeEach(() => {
  usePerfStreamMock.mockReset()
  exportPerfSnapshotMock.mockClear()
  toastSuccessMock.mockClear()
})

describe("PerformanceDashboard", () => {
  it("renders the desktop-only explainer when native runtime is unavailable", () => {
    usePerfStreamMock.mockReturnValue({ ...baseState, available: false })
    render(<PerformanceDashboard />)
    expect(screen.getByTestId("perf-desktop-only")).toBeInTheDocument()
    expect(screen.queryByTestId("performance-dashboard")).not.toBeInTheDocument()
  })

  it("renders the full dashboard with four tabs when available", () => {
    usePerfStreamMock.mockReturnValue({ ...baseState, available: true })
    render(<PerformanceDashboard />)
    expect(screen.getByTestId("performance-dashboard")).toBeInTheDocument()
    expect(screen.getByTestId("toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("perf-tab-overview")).toBeInTheDocument()
    expect(screen.getByTestId("perf-tab-processes")).toBeInTheDocument()
    expect(screen.getByTestId("perf-tab-hotspots")).toBeInTheDocument()
    expect(screen.getByTestId("perf-tab-runtime")).toBeInTheDocument()
    // Default tab content is the overview.
    expect(screen.getByTestId("overview")).toBeInTheDocument()
  })

  it("exports a snapshot and toasts the filename", () => {
    usePerfStreamMock.mockReturnValue({ ...baseState, available: true })
    render(<PerformanceDashboard />)
    fireEvent.click(screen.getByTestId("toolbar"))
    expect(exportPerfSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ format: "json", history: [], latest: null })
    )
    expect(toastSuccessMock).toHaveBeenCalled()
  })

  it("switches between tabs, rendering each tab's content", () => {
    usePerfStreamMock.mockReturnValue({
      ...baseState,
      available: true,
      latest: {
        tsMs: 1,
        intervalMs: 1000,
        processes: [],
        runtime: {
          workers: 1,
          aliveTasks: 0,
          globalQueueDepth: 0,
          blockingThreads: 0,
          blockingQueueDepth: 0,
          spawnedTasksCount: 0,
          budgetForcedYieldCount: 0,
          busyPct: 0,
          perWorkerBusyPct: [0],
        },
        topSpans: [],
        systemMemory: null,
        managed: [],
      },
    })
    render(<PerformanceDashboard />)
    fireEvent.click(screen.getByTestId("perf-tab-processes"))
    expect(screen.getByTestId("proc")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("perf-tab-hotspots"))
    expect(screen.getByTestId("hot")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("perf-tab-runtime"))
    expect(screen.getByTestId("rt")).toBeInTheDocument()
  })
})
