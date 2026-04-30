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
  }
})

import { ChartRenderer } from "./chart-renderer"
import { loggers } from "@/lib/logger"

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
})
