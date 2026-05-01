/**
 * A2UI Chart Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
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
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="line-chart">{children}</div>
  ),
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  PieChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="pie-chart">{children}</div>
  ),
  AreaChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="area-chart">{children}</div>
  ),
  Line: () => <div data-testid="line" />,
  Bar: () => <div data-testid="bar" />,
  Pie: () => <div data-testid="pie" />,
  Area: () => <div data-testid="area" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
  Legend: () => <div data-testid="legend" />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  Cell: () => <div data-testid="cell" />,
}))

describe("A2UIChart", () => {
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
