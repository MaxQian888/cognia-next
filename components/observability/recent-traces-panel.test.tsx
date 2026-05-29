/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { RecentTracesPanel } from "./recent-traces-panel"
import { panelById } from "./panel-registry"
import type { TraceRollupRow } from "@/lib/observability/trace-rollup"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function trace(over: Partial<TraceRollupRow> = {}): TraceRollupRow {
  return {
    traceId: "t1",
    rootName: "chat",
    startTime: 1_700_000_000_000,
    durationMs: 1200,
    spanCount: 3,
    errorCount: 0,
    totalCostUsd: 0.05,
    surface: "chat",
    ...over,
  }
}

describe("RecentTracesPanel", () => {
  it("shows the empty hint with no traces", () => {
    render(<RecentTracesPanel panel={panelById("traces")!} traces={[]} onSelectTrace={jest.fn()} />)
    expect(screen.getByText("traces.empty")).toBeInTheDocument()
  })

  it("renders rows and fires onSelectTrace on click", () => {
    const onSelect = jest.fn()
    render(
      <RecentTracesPanel
        panel={panelById("traces")!}
        traces={[trace(), trace({ traceId: "t2", errorCount: 1, rootName: "Bash" })]}
        onSelectTrace={onSelect}
      />
    )
    expect(screen.getByText("Bash")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("trace-row-t1"))
    expect(onSelect).toHaveBeenCalledWith("t1")
  })
})
