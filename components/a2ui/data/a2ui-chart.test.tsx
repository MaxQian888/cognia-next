/**
 * A2UI Chart Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UIChart } from "./a2ui-chart"
import type { A2UIChartComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock the A2UI context
const mockDataCtx = {
  surface: null,
  dataModel: {},
  components: {},
  resolveString: (value: string | { path: string }) => (typeof value === "string" ? value : ""),
  resolveNumber: (value: number | { path: string }) => (typeof value === "number" ? value : 0),
  resolveBoolean: (value: boolean | { path: string }) =>
    typeof value === "boolean" ? value : false,
  resolveArray: <T,>(value: T[] | { path: string }, d: T[] = []) =>
    Array.isArray(value) ? value : d,
}
jest.mock("@/hooks/a2ui", () => ({
  useA2UIContext: () => ({ ...mockDataCtx }),
  useA2UIData: () => mockDataCtx,
  useA2UIActions: () => ({
    surfaceId: "test-surface",
    catalog: undefined,
    emitAction: jest.fn(),
    setDataValue: jest.fn(),
    getBindingPath: jest.fn(),
    getComponent: jest.fn(),
    renderChild: jest.fn(),
  }),
}))

// Mock data-model functions
jest.mock("@/lib/a2ui/data-model", () => ({
  resolveArrayOrPath: (value: unknown) => {
    if (Array.isArray(value)) return value
    return []
  },
}))

// Mock recharts components
jest.mock("recharts", () => ({
  LineChart: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: (state: { activeTooltipIndex: string }) => void
  }) => (
    <div data-testid="line-chart" onClick={() => onClick?.({ activeTooltipIndex: "1" })}>
      {children}
    </div>
  ),
  BarChart: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: (state: { activeTooltipIndex: string }) => void
  }) => (
    <div data-testid="bar-chart" onClick={() => onClick?.({ activeTooltipIndex: "1" })}>
      {children}
    </div>
  ),
  PieChart: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: (state: { activeTooltipIndex: string }) => void
  }) => (
    <div data-testid="pie-chart" onClick={() => onClick?.({ activeTooltipIndex: "1" })}>
      {children}
    </div>
  ),
  AreaChart: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: (state: { activeTooltipIndex: string }) => void
  }) => (
    <div data-testid="area-chart" onClick={() => onClick?.({ activeTooltipIndex: "1" })}>
      {children}
    </div>
  ),
  Line: () => <div data-testid="line" />,
  Bar: () => <div data-testid="bar" />,
  Pie: () => <div data-testid="pie" />,
  Area: () => <div data-testid="area" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: ({ dataKey }: { dataKey?: string }) => <div data-testid="y-axis" data-key={dataKey} />,
  CartesianGrid: () => <div data-testid="grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
  Legend: () => <div data-testid="legend" />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  Cell: () => <div data-testid="cell" />,
  ScatterChart: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: (state: { activeTooltipIndex: string }) => void
  }) => (
    <div data-testid="scatter-chart" onClick={() => onClick?.({ activeTooltipIndex: "1" })}>
      {children}
    </div>
  ),
  RadarChart: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: (state: { activeTooltipIndex: string }) => void
  }) => (
    <div data-testid="radar-chart" onClick={() => onClick?.({ activeTooltipIndex: "1" })}>
      {children}
    </div>
  ),
  Scatter: () => <div />,
  Radar: () => <div />,
  PolarGrid: () => <div />,
  PolarAngleAxis: () => <div />,
  PolarRadiusAxis: () => <div />,
}))

describe("A2UIChart", () => {
  it.each(["line", "bar", "area", "pie", "donut", "scatter", "radar"] as const)(
    "dispatches the actual clicked row for %s",
    (chartType) => {
      const onAction = jest.fn()
      const data = [
        { name: "A", value: 10 },
        { name: "B", value: 20 },
      ]
      render(
        <A2UIChart
          component={{ id: "click", component: "Chart", chartType, data, clickAction: "point" }}
          surfaceId="s"
          dataModel={{}}
          onAction={onAction}
          onDataChange={jest.fn()}
          renderChild={() => null}
        />
      )
      fireEvent.click(screen.getByTestId(`${chartType === "donut" ? "pie" : chartType}-chart`))
      expect(onAction).toHaveBeenCalledWith("point", { dataPoint: data[1], index: 1 })
    }
  )

  it("provides an explicit numeric value axis for scatter series", () => {
    render(
      <A2UIChart
        component={{
          id: "scatter",
          component: "Chart",
          chartType: "scatter",
          data: [{ name: "A", value: 10, x: 1, y: 10 }],
          xKey: "x",
          yKeys: ["y"],
        }}
        surfaceId="s"
        dataModel={{}}
        onAction={jest.fn()}
        onDataChange={jest.fn()}
        renderChild={() => null}
      />
    )
    expect(screen.getByTestId("y-axis")).toHaveAttribute("data-key", "__a2uiScatterValue")
  })

  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UIChartComponent): A2UIComponentProps<A2UIChartComponent> => ({
    component,
    surfaceId: "test-surface",
    dataModel: {},
    onAction: mockOnAction,
    onDataChange: mockOnDataChange,
    renderChild: mockRenderChild,
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should render a line chart by default", () => {
    const component: A2UIChartComponent = {
      id: "chart-1",
      component: "Chart",
      chartType: "line",
      data: [
        { name: "A", value: 10 },
        { name: "B", value: 20 },
      ],
    }

    render(<A2UIChart {...createProps(component)} />)
    expect(screen.getByTestId("line-chart")).toBeInTheDocument()
  })

  it("should render a bar chart when specified", () => {
    const component: A2UIChartComponent = {
      id: "chart-2",
      component: "Chart",
      chartType: "bar",
      data: [
        { name: "A", value: 10 },
        { name: "B", value: 20 },
      ],
    }

    render(<A2UIChart {...createProps(component)} />)
    expect(screen.getByTestId("bar-chart")).toBeInTheDocument()
  })

  it("should render a pie chart when specified", () => {
    const component: A2UIChartComponent = {
      id: "chart-3",
      component: "Chart",
      chartType: "pie",
      data: [
        { name: "A", value: 30 },
        { name: "B", value: 70 },
      ],
    }

    render(<A2UIChart {...createProps(component)} />)
    expect(screen.getByTestId("pie-chart")).toBeInTheDocument()
  })

  it("should render an area chart when specified", () => {
    const component: A2UIChartComponent = {
      id: "chart-4",
      component: "Chart",
      chartType: "area",
      data: [
        { name: "A", value: 15 },
        { name: "B", value: 25 },
      ],
    }

    render(<A2UIChart {...createProps(component)} />)
    expect(screen.getByTestId("area-chart")).toBeInTheDocument()
  })

  it("should render title when provided", () => {
    const component: A2UIChartComponent = {
      id: "chart-5",
      component: "Chart",
      chartType: "line",
      title: "Sales Chart",
      data: [],
    }

    render(<A2UIChart {...createProps(component)} />)
    expect(screen.getByText("Sales Chart")).toBeInTheDocument()
  })

  it("should apply custom className", () => {
    const component: A2UIChartComponent = {
      id: "chart-6",
      component: "Chart",
      chartType: "line",
      data: [],
      className: "custom-class",
    }

    const { container } = render(<A2UIChart {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })
})
