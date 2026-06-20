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

// Deterministic virtualizer window (mirrors the log-virtualized-list test).
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    getScrollElement,
  }: {
    count: number
    estimateSize: () => number
    getScrollElement: () => HTMLElement | null
  }) => {
    estimateSize?.()
    getScrollElement?.()
    // Window mid-scroll (start at index 2) so BOTH the top and bottom spacer
    // rows are exercised when the dataset is large enough.
    const startIndex = count > 5 ? 2 : 0
    const windowed = Array.from({ length: Math.min(count, 5) }, (_, i) => {
      const index = startIndex + i
      return { index, start: index * 44, size: 44, end: (index + 1) * 44, key: index, lane: 0 }
    })
    return {
      getVirtualItems: () => windowed,
      getTotalSize: () => count * 44,
      measureElement: jest.fn(),
    }
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

  describe("row virtualization", () => {
    const bigData = Array.from({ length: 150 }, (_, i) => ({ id: i, name: `Person ${i}` }))
    const columns = [{ key: "name", header: "Name" }]

    it("renders all rows for a small table (no virtualization)", () => {
      const component: A2UITableComponent = {
        id: "small",
        component: "Table",
        columns,
        data: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
        ],
      }
      render(<A2UITable {...createProps(component)} />)
      expect(screen.queryByTestId("a2ui-table-virtual-pad-bottom")).not.toBeInTheDocument()
      expect(screen.getByText("Alice")).toBeInTheDocument()
      expect(screen.getByText("Bob")).toBeInTheDocument()
    })

    it("windows a large un-paginated table with a spacer row", () => {
      const component: A2UITableComponent = {
        id: "big",
        component: "Table",
        columns,
        data: bigData,
      }
      render(<A2UITable {...createProps(component)} />)

      // Only the windowed (mid-scroll) subset of rows is in the DOM...
      expect(screen.getByText("Person 2")).toBeInTheDocument()
      expect(screen.getByText("Person 6")).toBeInTheDocument()
      expect(screen.queryByText("Person 0")).not.toBeInTheDocument()
      expect(screen.queryByText("Person 100")).not.toBeInTheDocument()
      // ...with top and bottom spacers preserving total scroll height.
      expect(screen.getByTestId("a2ui-table-virtual-pad-top")).toBeInTheDocument()
      expect(screen.getByTestId("a2ui-table-virtual-pad-bottom")).toBeInTheDocument()
    })

    it("does NOT virtualize when pagination is enabled (DOM already bounded)", () => {
      const component: A2UITableComponent = {
        id: "paged",
        component: "Table",
        columns,
        data: bigData,
        pagination: true,
        pageSize: 10,
      }
      render(<A2UITable {...createProps(component)} />)
      expect(screen.queryByTestId("a2ui-table-virtual-pad-bottom")).not.toBeInTheDocument()
      // Paginated path shows exactly the first page.
      expect(screen.getByText("Person 0")).toBeInTheDocument()
      expect(screen.getByText("Person 9")).toBeInTheDocument()
      expect(screen.queryByText("Person 10")).not.toBeInTheDocument()
    })
  })
})
