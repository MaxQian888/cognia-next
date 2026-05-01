/**
 * A2UI Table Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UITable } from "./a2ui-table"
import type { A2UITableComponent, A2UIComponentProps } from "@/types/a2ui/schema"

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
jest.mock("../a2ui-context", () => ({
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

describe("A2UITable", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UITableComponent): A2UIComponentProps<A2UITableComponent> => ({
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

  it("should render a table with columns and data", () => {
    const component: A2UITableComponent = {
      id: "table-1",
      component: "Table",
      columns: [
        { key: "name", header: "Name" },
        { key: "age", header: "Age", type: "number" },
      ],
      data: [
        { id: "1", name: "John", age: 30 },
        { id: "2", name: "Jane", age: 25 },
      ],
    }

    render(<A2UITable {...createProps(component)} />)
    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Age")).toBeInTheDocument()
    expect(screen.getByText("John")).toBeInTheDocument()
    expect(screen.getByText("Jane")).toBeInTheDocument()
  })

  it("should show empty message when no data", () => {
    const component: A2UITableComponent = {
      id: "table-2",
      component: "Table",
      columns: [{ key: "name", header: "Name" }],
      data: [],
      emptyMessage: "No records found",
    }

    render(<A2UITable {...createProps(component)} />)
    expect(screen.getByText("No records found")).toBeInTheDocument()
  })

  it("should render title when provided", () => {
    const component: A2UITableComponent = {
      id: "table-3",
      component: "Table",
      title: "User List",
      columns: [{ key: "name", header: "Name" }],
      data: [],
    }

    render(<A2UITable {...createProps(component)} />)
    expect(screen.getByText("User List")).toBeInTheDocument()
  })

  it("should call onAction when row is clicked with rowClickAction", () => {
    const component: A2UITableComponent = {
      id: "table-4",
      component: "Table",
      columns: [{ key: "name", header: "Name" }],
      data: [{ id: "1", name: "John" }],
      rowClickAction: "row-clicked",
    }

    render(<A2UITable {...createProps(component)} />)
    fireEvent.click(screen.getByText("John"))

    expect(mockOnAction).toHaveBeenCalledWith(
      "row-clicked",
      expect.objectContaining({
        row: { id: "1", name: "John" },
        index: 0,
      })
    )
  })

  it("should apply custom className", () => {
    const component: A2UITableComponent = {
      id: "table-5",
      component: "Table",
      columns: [{ key: "name", header: "Name" }],
      data: [],
      className: "custom-class",
    }

    const { container } = render(<A2UITable {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })
})
