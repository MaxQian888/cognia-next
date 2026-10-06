import { fireEvent, render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { parseChartPayload } from "@/lib/artifacts"
import { readChatDiagramPalette } from "@/lib/chat/diagram-palette"
import { ChartBlock, chartLegendItems, chartTableColumns } from "./chart-block"

jest.mock("@/components/artifacts/chart-plot", () => ({
  ...jest.requireActual("@/components/artifacts/chart-plot"),
  ChartPlot: ({ contract }: { contract: { chartType: string; series: string[] } }) => (
    <div
      data-testid="chart-plot"
      data-type={contract.chartType}
      data-series={contract.series.join(",")}
    />
  ),
}))

const copy = jest.fn(async () => true)
jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, copy }),
}))

const BAR = JSON.stringify({
  type: "bar",
  title: "Render cost",
  data: [
    { name: "Code", before: 40, after: 12 },
    { name: "Table", before: 9, after: 4 },
  ],
})

const renderBlock = (content: string, isIncomplete = false) =>
  render(
    <TooltipProvider>
      <ChartBlock content={content} isIncomplete={isIncomplete} />
    </TooltipProvider>
  )

beforeEach(() => copy.mockClear())

describe("ChartBlock", () => {
  it("draws the payload in the shared frame, titled from the payload", () => {
    const { container } = renderBlock(BAR)
    const frame = container.querySelector('[data-rich-block="chart"]')!
    expect(frame).toHaveAttribute("role", "figure")
    expect(frame).toHaveAttribute("aria-label", "Render cost")
    expect(frame.querySelector("[data-rich-block-header]")).toHaveTextContent("Render cost")
    expect(frame.querySelector("[data-rich-block-header]")).toHaveTextContent("Bar chart")
    expect(screen.getByTestId("chart-plot")).toHaveAttribute("data-series", "before,after")
  })

  it("labels an untitled chart by its type", () => {
    renderBlock(JSON.stringify({ type: "line", data: [{ name: "a", v: 1 }] }))
    expect(screen.getByRole("figure")).toHaveAttribute("aria-label", "Line chart")
  })

  it("holds a sized placeholder while the fence streams, without parsing it", () => {
    const { container } = renderBlock('{"type":"bar","data":[{"na', true)
    expect(container.querySelector('[data-rich-block="chart"]')).toHaveAttribute(
      "aria-busy",
      "true"
    )
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("switches to the data table and back, and copies the JSON", () => {
    renderBlock(BAR)
    fireEvent.click(screen.getByRole("button", { name: "Show data" }))
    const table = screen.getByRole("table")
    expect(table).toHaveTextContent("namebeforeafter")
    expect(table).toHaveTextContent("Code4012")
    expect(screen.getByRole("button", { name: "Download PNG" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }))
    expect(screen.getByTestId("chart-plot")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Copy chart JSON" }))
    expect(copy).toHaveBeenCalledWith(BAR)
  })

  it("opens a fullscreen view with the chart and its data", () => {
    renderBlock(BAR)
    fireEvent.click(screen.getByRole("button", { name: "View fullscreen" }))
    const dialog = screen.getByTestId("chart-fullscreen")
    expect(dialog).toHaveTextContent("2 data points")
    expect(dialog.querySelector("table")).toBeInTheDocument()
  })

  it("explains an invalid payload with the shared error state and the source", () => {
    renderBlock("{not json")
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("This chart could not be drawn")
    expect(alert.querySelector("pre")).toHaveTextContent("{not json")
  })

  it("annotates a degraded payload and still draws it", () => {
    renderBlock(
      JSON.stringify({
        type: "pie",
        data: [
          { name: "a", x: 1, y: 2 },
          { name: "b", x: 3, y: 4 },
        ],
      })
    )
    expect(screen.getByTestId("chart-plot")).toBeInTheDocument()
    expect(screen.getByTestId("chart-block-notice")).toBeInTheDocument()
  })

  it("shows the empty state when nothing is drawable", () => {
    renderBlock(JSON.stringify({ type: "bar", data: [{ name: "a", label: "x" }] }))
    expect(screen.queryByTestId("chart-plot")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Show data" })).not.toBeInTheDocument()
  })
})

describe("chart helpers", () => {
  const palette = readChatDiagramPalette()

  it("picks the data-table columns per shape", () => {
    expect(chartTableColumns(parseChartPayload(BAR))).toEqual(["name", "before", "after"])
    expect(
      chartTableColumns(
        parseChartPayload(JSON.stringify({ type: "pie", data: [{ name: "a", share: 1 }] }))
      )
    ).toEqual(["name", "share"])
    expect(
      chartTableColumns(
        parseChartPayload(JSON.stringify({ type: "scatter", data: [{ x: 1, y: 2 }] }))
      )
    ).toEqual(["x", "y"])
  })

  it("builds legend entries in palette order", () => {
    const series = chartLegendItems(parseChartPayload(BAR), palette, "Series")
    expect(series.map((item) => item.label)).toEqual(["before", "after"])
    expect(series[0].color).toBe(palette.colors.chart[0])
    const slices = chartLegendItems(
      parseChartPayload(
        JSON.stringify({
          type: "pie",
          data: [
            { name: "a", v: 1 },
            { name: "b", v: 2 },
          ],
        })
      ),
      palette,
      "Series"
    )
    expect(slices.map((item) => item.label)).toEqual(["a", "b"])
    expect(
      chartLegendItems(
        parseChartPayload(JSON.stringify({ type: "scatter", data: [{ x: 1, y: 2 }] })),
        palette,
        "Series"
      )
    ).toEqual([{ label: "Series", color: palette.colors.chart[0] }])
  })
})
