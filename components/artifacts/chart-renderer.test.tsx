/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Recharts measures DOM size; jsdom returns 0 which crashes ResponsiveContainer.
// Replace it with a passthrough so chart subtree renders for assertion.
jest.mock("recharts", () => {
  const actual = jest.requireActual("recharts")
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) => (
      <div style={{ width: 400, height: 300 }}>
        {actual.cloneElement
          ? actual.cloneElement(children, { width: 400, height: 300 })
          : children}
      </div>
    ),
    // Recharts paints no SVG under jsdom, so the rendered tree cannot prove
    // which key a Pie sliced by. Surface the props that decide it instead:
    // `dataKey` IS the contract these tests are about.
    // ...and the chart container too, because the real one resolves its
    // children by recharts-internal identity and silently drops a stand-in.
    PieChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    ScatterChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Pie: Object.assign(
      ({ dataKey, children }: { dataKey?: string; children?: React.ReactNode }) => (
        <div data-testid="pie" data-datakey={String(dataKey)}>
          {children}
        </div>
      ),
      { displayName: "Pie" }
    ),
    Scatter: Object.assign(
      ({ name }: { name?: string }) => <div data-testid="scatter" data-name={name} />,
      { displayName: "Scatter" }
    ),
  }
})

import { ChartRenderer } from "./chart-renderer"
import { loggers } from "@cognia/logging"

describe("ChartRenderer", () => {
  it("renders an alert for invalid JSON and logs a warning", () => {
    const warnSpy = jest.spyOn(loggers.ui, "warn").mockImplementation()
    render(<ChartRenderer content="not json" />)
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(warnSpy).toHaveBeenCalledWith(
      "artifacts.chart.parse-failed",
      expect.objectContaining({ contentLength: expect.any(Number) })
    )
    warnSpy.mockRestore()
  })

  it("renders an empty-state for empty arrays", () => {
    render(<ChartRenderer content="[]" />)
    expect(screen.getByText("noChartData")).toBeInTheDocument()
  })

  it("accepts a configured chart object with `type` and `data`", () => {
    const payload = JSON.stringify({
      type: "bar",
      data: [
        { name: "a", value: 1 },
        { name: "b", value: 2 },
      ],
    })
    render(<ChartRenderer content={payload} />)
    // No alert means parsing succeeded.
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("accepts a bare data array", () => {
    const payload = JSON.stringify([
      { name: "a", value: 1 },
      { name: "b", value: 2 },
    ])
    render(<ChartRenderer content={payload} />)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("rejects a JSON object that is neither an array nor `{ data: [] }`", () => {
    render(<ChartRenderer content={JSON.stringify({ foo: "bar" })} />)
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("uses the chartData prop when provided", () => {
    render(
      <ChartRenderer
        content="ignored"
        chartData={[
          { name: "a", value: 1 },
          { name: "b", value: 2 },
        ]}
      />
    )
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it.each(["pie", "doughnut", "area", "scatter", "radar", "line"])(
    "renders without crashing for chartType=%s",
    (type) => {
      const payload = JSON.stringify({
        type,
        data: [
          { name: "a", value: 1, x: 1, y: 1 },
          { name: "b", value: 2, x: 2, y: 4 },
        ],
      })
      render(<ChartRenderer content={payload} />)
      expect(screen.queryByRole("alert")).toBeNull()
    }
  )
  describe("the chart contract, said out loud", () => {
    it("draws a pie whose series is not called `value`", () => {
      // This payload used to render a completely blank pie: the Pie hardcoded
      // dataKey="value". Every fixture above uses `value`, which is exactly
      // why the suite could not catch it.
      render(
        <ChartRenderer
          chartType="pie"
          content={JSON.stringify({
            type: "pie",
            data: [
              { name: "Chrome", share: 62 },
              { name: "Safari", share: 21 },
            ],
          })}
        />
      )
      expect(screen.getByTestId("pie")).toHaveAttribute("data-datakey", "share")
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    })

    it("annotates a bent rule without replacing the chart", () => {
      const { container } = render(
        <ChartRenderer
          content={JSON.stringify({
            type: "histogram",
            data: [
              { name: "Jan", value: 1 },
              { name: "Feb", value: 2 },
            ],
          })}
        />
      )
      expect(screen.getByTestId("chart-contract-notice")).toHaveAttribute("role", "status")
      expect(screen.getByText("chartFindings.unknownType")).toBeInTheDocument()
      // Still a chart. The notice is non-blocking by construction.
      expect(container.querySelector(".recharts-wrapper")).toBeInTheDocument()
    })

    it("never escalates a bent rule into an assertive alert", () => {
      render(
        <ChartRenderer
          content={JSON.stringify({
            type: "line",
            data: [
              { name: "Jan", revenue: 1 },
              { name: "Feb", revenue: 2, cost: 3 },
            ],
          })}
        />
      )
      expect(screen.getByText("chartFindings.lateSeries")).toBeInTheDocument()
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    })

    it("shows the empty state and the reason together", () => {
      render(<ChartRenderer content={JSON.stringify([{ name: "a" }])} />)
      expect(screen.getByText("noChartData")).toBeInTheDocument()
      expect(screen.getByText("chartFindings.noNumericSeries")).toBeInTheDocument()
    })

    it("names the scatter series from i18n rather than a literal", () => {
      render(
        <ChartRenderer
          chartType="scatter"
          content={JSON.stringify({ type: "scatter", data: [{ x: 1, y: 2 }] })}
        />
      )
      expect(screen.getByTestId("scatter")).toHaveAttribute("data-name", "chartSeriesFallbackName")
    })
  })
})
