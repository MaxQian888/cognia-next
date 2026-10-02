jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children, data }: { children: React.ReactNode; data: unknown[] }) => (
    <svg data-testid="latency-chart" data-points={JSON.stringify(data)}>
      {children}
    </svg>
  ),
  Line: ({ dataKey, connectNulls }: { dataKey: string; connectNulls?: boolean }) => (
    <path data-testid={`line-${dataKey}`} data-connect-nulls={String(connectNulls)} />
  ),
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: ({
    labelFormatter,
    formatter,
  }: {
    labelFormatter?: (value: string) => string
    formatter?: (value: number, name: string) => [string, string]
  }) => (
    <div data-testid="latency-tooltip">
      {labelFormatter?.("2026-10-02T08:00:00.000Z")}|{formatter?.(120, "p95").join("/")}
    </div>
  ),
}))

import { render, screen } from "@testing-library/react"

import { createStatusFixture } from "@/lib/status/fixtures"
import type { ComponentSnapshot } from "@/lib/status/public-status"

import { LatencyPanel } from "./latency-panel"

describe("LatencyPanel", () => {
  it("summarises p50/p95 in text and documents the minimum-sample rule", () => {
    const latency = createStatusFixture("operational").components[0]!.latency
    render(<LatencyPanel latency={latency} componentName="Signaling HTTP" />)
    const summary = screen.getByTestId("latency-summary")
    expect(summary).toHaveTextContent(
      `Median ${latency.summary.p50Ms} ms and p95 ${latency.summary.p95Ms} ms`
    )
    expect(summary).toHaveTextContent("Every bucket has enough samples.")
    expect(
      screen.getByText(/at least 5 successful samples\. Failed attempts are not timed/)
    ).toBeInTheDocument()
    expect(
      screen.getByRole("img", { name: "Signaling HTTP latency, p50 and p95 per bucket" })
    ).toHaveAttribute("aria-describedby", summary.id)
    expect(screen.getByTestId("latency-tooltip")).toHaveTextContent("120 ms/p95")
  })

  it("draws buckets below the minimum as gaps, not zero", () => {
    const base = createStatusFixture("operational").components[0]!.latency
    const latency: ComponentSnapshot["latency"] = {
      ...base,
      buckets: base.buckets.map((bucket, index) =>
        index < 3 ? { ...bucket, sampleCount: 2, p50Ms: null, p95Ms: null } : bucket
      ),
    }
    render(<LatencyPanel latency={latency} componentName="X" />)
    const points = JSON.parse(screen.getByTestId("latency-chart").getAttribute("data-points")!)
    expect(points[0]).toMatchObject({ p50: null, p95: null, samples: 2 })
    expect(screen.getByTestId("line-p50")).toHaveAttribute("data-connect-nulls", "false")
    expect(screen.getByTestId("latency-summary")).toHaveTextContent(
      "3 buckets have too few samples and are shown as gaps."
    )
  })

  it("says there is not enough data instead of showing a number", () => {
    const latency = createStatusFixture("empty").components[0]!.latency
    render(<LatencyPanel latency={latency} componentName="X" />)
    expect(screen.getByTestId("latency-summary")).toHaveTextContent(
      "Not enough successful samples to show latency for this period."
    )
  })
})
