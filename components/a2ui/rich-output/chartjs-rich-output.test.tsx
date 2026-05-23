/**
 * Tests for ChartJsRichOutput.
 *
 * react-chartjs-2 is mocked so we don't have to spin up a real Chart.js
 * instance under jsdom (no canvas implementation in the default test env).
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import type { A2UIRichOutputChartData } from "@/types/a2ui/schema"

jest.mock("react-chartjs-2", () => ({
  Line: ({ data }: { data: unknown }) => (
    <div data-testid="chartjs-line" data-shape={JSON.stringify(data)} />
  ),
  Bar: ({ data }: { data: unknown }) => (
    <div data-testid="chartjs-bar" data-shape={JSON.stringify(data)} />
  ),
  Doughnut: ({ data }: { data: unknown }) => (
    <div data-testid="chartjs-doughnut" data-shape={JSON.stringify(data)} />
  ),
}))

// Avoid pulling the real chart.js into jest (no canvas in jsdom)
jest.mock("chart.js", () => {
  const noop = () => {}
  return {
    Chart: { register: noop },
    CategoryScale: noop,
    LinearScale: noop,
    PointElement: noop,
    LineElement: noop,
    BarElement: noop,
    ArcElement: noop,
    Tooltip: noop,
    Legend: noop,
  }
})

import { ChartJsRichOutput } from "./chartjs-rich-output"

const sampleData: A2UIRichOutputChartData = {
  labels: ["Jan", "Feb", "Mar"],
  datasets: [{ label: "Revenue", data: [10, 20, 30] }],
}

describe("ChartJsRichOutput", () => {
  it("renders a Line chart by default", () => {
    render(<ChartJsRichOutput chartType="line" data={sampleData} />)
    expect(screen.getByTestId("chartjs-line")).toBeInTheDocument()
    expect(screen.queryByTestId("chartjs-bar")).toBeNull()
  })

  it("renders a Bar chart for chartType=bar", () => {
    render(<ChartJsRichOutput chartType="bar" data={sampleData} />)
    expect(screen.getByTestId("chartjs-bar")).toBeInTheDocument()
  })

  it("renders a Doughnut chart for chartType=doughnut", () => {
    render(<ChartJsRichOutput chartType="doughnut" data={sampleData} />)
    expect(screen.getByTestId("chartjs-doughnut")).toBeInTheDocument()
  })

  it("decorates each dataset with borderWidth: 2", () => {
    render(<ChartJsRichOutput chartType="line" data={sampleData} />)
    const shape = JSON.parse(screen.getByTestId("chartjs-line").getAttribute("data-shape") || "{}")
    expect(shape.datasets[0].borderWidth).toBe(2)
    expect(shape.labels).toEqual(["Jan", "Feb", "Mar"])
  })

  it("applies the supplied height to the wrapper", () => {
    const { container } = render(
      <ChartJsRichOutput chartType="bar" data={sampleData} height={420} />
    )
    expect((container.firstChild as HTMLElement).style.height).toBe("420px")
  })
})
