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

let mockSearch = ""
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearch),
}))

// Controlled Tabs stub: Radix activates on focus (not click), which is flaky in
// jsdom. This mirrors the controlled API the dashboard now uses (value +
// onValueChange) and renders only the active content.
jest.mock("@/components/ui/tabs", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react")
  const Ctx = ReactLib.createContext({ value: "", onValueChange: (_v: string) => {} })
  return {
    Tabs: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode
      value: string
      onValueChange: (v: string) => void
    }) => ReactLib.createElement(Ctx.Provider, { value: { value, onValueChange } }, children),
    TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    TabsTrigger: ({ children, value, ...rest }: { children: React.ReactNode; value: string }) => {
      const ctx = ReactLib.useContext(Ctx)
      return (
        <button
          {...rest}
          data-active={ctx.value === value}
          onClick={() => ctx.onValueChange(value)}
        >
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
const resetHotspotsMock = jest.fn(async () => {})
jest.mock("@/lib/perf/backend/commands", () => ({
  perfResetHotspots: () => resetHotspotsMock(),
}))
let mockCapture = { active: false }
jest.mock("@/lib/perf/capture-controller", () => ({
  getPerformanceCaptureController: () => ({
    get snapshot() {
      return mockCapture
    },
    subscribe: () => () => {},
  }),
}))
const toastSuccessMock = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccessMock(...a) } }))

jest.mock("./perf-toolbar", () => ({
  PerfToolbar: ({ onExport }: { onExport: (f: string) => void }) => (
    <button data-testid="toolbar" onClick={() => onExport("json")} />
  ),
  PerfLiveStatus: ({
    recording,
    onOpenCaptures,
  }: {
    recording: boolean
    onOpenCaptures: () => void
  }) => <button data-testid="live-status" data-recording={recording} onClick={onOpenCaptures} />,
}))
jest.mock("./perf-overview-tab", () => ({
  PerfOverviewTab: ({
    selectedMetric,
    onSelectMetric,
    onOpenDiagnose,
  }: {
    selectedMetric: string | null
    onSelectMetric: (m: string) => void
    onOpenDiagnose: () => void
  }) => (
    <div data-testid="overview" data-metric={selectedMetric ?? ""}>
      <button data-testid="pick-fps" onClick={() => onSelectMetric("renderer.fps")} />
      <button data-testid="open-diagnose" onClick={onOpenDiagnose} />
    </div>
  ),
}))
jest.mock("./perf-process-table", () => ({ PerfProcessTable: () => <div data-testid="proc" /> }))
jest.mock("./perf-hotspots-table", () => ({
  PerfHotspotsTable: ({ onReset }: { onReset?: () => Promise<void> }) => (
    <button data-testid="hot" data-resettable={Boolean(onReset)} onClick={() => void onReset?.()} />
  ),
}))
jest.mock("./perf-runtime-tab", () => ({ PerfRuntimeTab: () => <div data-testid="rt" /> }))
jest.mock("./perf-system-tab", () => ({ PerfSystemTab: () => <div data-testid="system" /> }))
jest.mock("./perf-managed-processes", () => ({
  PerfManagedProcesses: () => <div data-testid="managed" />,
}))
jest.mock("./perf-source-health", () => ({
  PerfSourceHealth: ({ issue }: { issue?: { kind: string } | null }) => (
    <div data-testid="source-health" data-issue={issue?.kind ?? ""} />
  ),
  PerfSourceNotice: () => <div data-testid="source-notice" />,
}))
jest.mock("./perf-captures-tab", () => ({ PerfCapturesTab: () => <div data-testid="captures" /> }))
jest.mock("./perf-renderer-timings-table", () => ({
  PerfRendererTimingsTable: () => <div data-testid="renderer-timings" />,
}))
jest.mock("./perf-host-unavailable", () => ({
  PerfHostUnavailable: ({ section, notReported }: { section: string; notReported?: boolean }) => (
    <div data-testid={`host-unavailable-${section}`} data-not-reported={Boolean(notReported)} />
  ),
}))
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: () => null,
}))

import { PerformanceDashboard, PERF_TRACE_DASHBOARD_HREF } from "./performance-dashboard"

const rustHost = {
  kind: "host",
  runtimeKind: "tauri-rust",
  capabilities: ["host.processes", "runtime.tokio", "host.managed-processes"],
}
const nodeHost = {
  kind: "host",
  runtimeKind: "node-headless",
  capabilities: ["host.processes", "runtime.node", "host.managed-workers"],
}

const baseState = {
  history: [],
  latest: null,
  rendererHistory: [],
  hostHistory: [],
  sources: [],
  gaps: [],
  hostState: "unsupported",
  error: null,
  hostIssue: null,
  paused: false,
  intervalMs: 1000,
  available: true,
  setPaused: jest.fn(),
  setIntervalMs: jest.fn(),
  reset: jest.fn(),
}

beforeEach(() => {
  usePerfStreamMock.mockReset()
  exportPerfSnapshotMock.mockClear()
  toastSuccessMock.mockClear()
  resetHotspotsMock.mockClear()
  mockSearch = ""
  mockCapture = { active: false }
  window.history.replaceState(null, "", "/performance")
})

describe("PerformanceDashboard", () => {
  it("opens on Overview with the source notice above the metric rail", () => {
    usePerfStreamMock.mockReturnValue(baseState)
    render(<PerformanceDashboard />)
    expect(screen.getByTestId("performance-dashboard")).toBeInTheDocument()
    expect(screen.getByTestId("source-notice")).toBeInTheDocument()
    expect(screen.getByTestId("overview")).toBeInTheDocument()
    // The full source card moved to Diagnose.
    expect(screen.queryByTestId("source-health")).not.toBeInTheDocument()
  })

  it("lands on the tab, section and metric named in the URL", () => {
    mockSearch = "tab=resources&resource=runtime"
    usePerfStreamMock.mockReturnValue({
      ...baseState,
      hostState: "live",
      hostHistory: [{ runtime: {}, topSpans: [] }],
      sources: [rustHost],
    })
    render(<PerformanceDashboard />)
    expect(screen.getByTestId("rt")).toBeInTheDocument()
  })

  it("writes tab and metric changes to the URL in place", () => {
    usePerfStreamMock.mockReturnValue(baseState)
    render(<PerformanceDashboard />)
    fireEvent.click(screen.getByTestId("pick-fps"))
    expect(window.location.search).toBe("?metric=renderer.fps")
    expect(screen.getByTestId("overview")).toHaveAttribute("data-metric", "renderer.fps")
    fireEvent.click(screen.getByTestId("perf-tab-captures"))
    const params = new URLSearchParams(window.location.search)
    expect(params.get("tab")).toBe("captures")
    expect(params.get("metric")).toBe("renderer.fps")
    expect(screen.getByTestId("captures")).toBeInTheDocument()
  })

  it("routes the overview's source-details link to Diagnose, which carries the source card", () => {
    usePerfStreamMock.mockReturnValue({
      ...baseState,
      hostState: "connecting",
      hostIssue: { kind: "contended", code: "device-purpose-limit", detail: "busy" },
    })
    render(<PerformanceDashboard />)
    fireEvent.click(screen.getByTestId("open-diagnose"))
    expect(screen.getByTestId("source-health")).toHaveAttribute("data-issue", "contended")
    expect(screen.getByTestId("renderer-timings")).toBeInTheDocument()
    expect(screen.getByTestId("perf-diagnose-traces")).toHaveAttribute(
      "href",
      PERF_TRACE_DASHBOARD_HREF
    )
  })

  it("explains host-only sections without a host instead of disabling them", () => {
    mockSearch = "tab=resources"
    usePerfStreamMock.mockReturnValue(baseState)
    render(<PerformanceDashboard />)
    expect(screen.getByTestId("host-unavailable-processes")).toHaveAttribute(
      "data-not-reported",
      "false"
    )
    fireEvent.click(screen.getByTestId("perf-tab-diagnose"))
    expect(screen.getByTestId("host-unavailable-hotspots")).toBeInTheDocument()
  })

  it("marks sections the connected host's runtime does not report", () => {
    mockSearch = "tab=resources&resource=runtime"
    usePerfStreamMock.mockReturnValue({
      ...baseState,
      hostState: "live",
      hostHistory: [{ runtime: {}, topSpans: [] }],
      sources: [nodeHost],
    })
    render(<PerformanceDashboard />)
    expect(screen.getByTestId("host-unavailable-runtime")).toHaveAttribute(
      "data-not-reported",
      "true"
    )
    fireEvent.click(screen.getByTestId("perf-resource-managed"))
    expect(screen.getByTestId("managed")).toBeInTheDocument()
  })

  it("wires the hotspot reset to the host's span registry on the Rust host", () => {
    mockSearch = "tab=diagnose"
    usePerfStreamMock.mockReturnValue({
      ...baseState,
      hostState: "live",
      hostHistory: [{ runtime: {}, topSpans: [] }],
      sources: [rustHost],
    })
    render(<PerformanceDashboard />)
    expect(screen.getByTestId("hot")).toHaveAttribute("data-resettable", "true")
    fireEvent.click(screen.getByTestId("hot"))
    expect(resetHotspotsMock).toHaveBeenCalledTimes(1)
  })

  it("shows an active capture in the header and on the Captures tab", () => {
    mockCapture = { active: true }
    usePerfStreamMock.mockReturnValue(baseState)
    render(<PerformanceDashboard />)
    expect(screen.getByTestId("perf-tab-captures-recording")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("live-status"))
    expect(screen.getByTestId("captures")).toBeInTheDocument()
  })

  it("exports a snapshot and toasts the filename", () => {
    usePerfStreamMock.mockReturnValue(baseState)
    render(<PerformanceDashboard />)
    fireEvent.click(screen.getByTestId("toolbar"))
    expect(exportPerfSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ format: "json", history: [], latest: null })
    )
    expect(toastSuccessMock).toHaveBeenCalled()
  })
})
