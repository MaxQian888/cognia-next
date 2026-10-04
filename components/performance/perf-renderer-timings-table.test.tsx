/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { PERF_NAMESPACE } from "@/lib/perf/perf-marker"
import type { RendererMeasurementEntry } from "@/lib/perf/renderer-collector"
import { PerfRendererTimingsTable } from "./perf-renderer-timings-table"

function store() {
  const map = new Map<string, RendererMeasurementEntry[]>([
    [`${PERF_NAMESPACE}chat:turn`, [{ name: "", duration: 1200, startTime: 1 }]],
    [`${PERF_NAMESPACE}react:chat:list`, [{ name: "", duration: 8, startTime: 2 }]],
  ])
  return {
    map,
    read: () => map,
    clear: jest.fn(() => map.clear()),
  }
}

describe("PerfRendererTimingsTable", () => {
  it("lists renderer measures with their category", () => {
    const { read, clear } = store()
    render(<PerfRendererTimingsTable readMeasurements={read} onClear={clear} version={1} />)
    expect(screen.getByTestId("perf-renderer-timing-chat:turn")).toHaveTextContent("Chat")
    expect(screen.getByTestId("perf-renderer-timing-chat:turn")).toHaveTextContent("1.20 s")
    expect(screen.getByTestId("perf-renderer-timing-react:chat:list")).toHaveTextContent("Render")
  })

  it("filters by category", () => {
    const { read, clear } = store()
    render(<PerfRendererTimingsTable readMeasurements={read} onClear={clear} version={1} />)
    fireEvent.click(screen.getByTestId("perf-renderer-timings-filter-react"))
    expect(screen.queryByTestId("perf-renderer-timing-chat:turn")).not.toBeInTheDocument()
    expect(screen.getByTestId("perf-renderer-timings-filter-react")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  it("re-reads the collector when the version changes", () => {
    const { map, read, clear } = store()
    const { rerender } = render(
      <PerfRendererTimingsTable readMeasurements={read} onClear={clear} version={1} />
    )
    map.set(`${PERF_NAMESPACE}chat:dispatch-latency`, [{ name: "", duration: 3, startTime: 3 }])
    rerender(<PerfRendererTimingsTable readMeasurements={read} onClear={clear} version={2} />)
    expect(screen.getByTestId("perf-renderer-timing-chat:dispatch-latency")).toBeInTheDocument()
  })

  it("clears immediately and then shows the empty state", () => {
    const { read, clear } = store()
    render(<PerfRendererTimingsTable readMeasurements={read} onClear={clear} version={1} />)
    fireEvent.click(screen.getByTestId("perf-renderer-timings-clear"))
    expect(clear).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("perf-renderer-timings-empty")).toBeInTheDocument()
    expect(screen.getByTestId("perf-renderer-timings-clear")).toBeDisabled()
  })
})
