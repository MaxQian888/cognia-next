/**
 * A2UI List Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UIList } from "./a2ui-list"
import type { A2UIListComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock useA2UIListNavigation hook
const mockSetActiveIndex = jest.fn()
jest.mock("@/hooks/a2ui/use-a2ui-keyboard", () => ({
  useA2UIListNavigation: () => ({
    activeIndex: 0,
    setActiveIndex: mockSetActiveIndex,
    activeItem: null,
  }),
}))

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
const mockActionsRenderChild = jest.fn((_id: string): React.ReactNode => null)
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
    renderChild: mockActionsRenderChild,
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
    const windowed = Array.from({ length: Math.min(count, 5) }, (_, i) => ({
      index: i,
      start: i * 40,
      size: 40,
      end: (i + 1) * 40,
      key: i,
      lane: 0,
    }))
    return {
      getVirtualItems: () => windowed,
      getTotalSize: () => count * 40,
      measureElement: jest.fn(),
    }
  },
}))

// Mock the A2UI renderer
jest.mock("../a2ui-child-renderer", () => ({
  A2UIChildRenderer: ({ childIds }: { childIds: string[] }) => (
    <div data-testid="children">{childIds.join(",")}</div>
  ),
}))

describe("A2UIList", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UIListComponent): A2UIComponentProps<A2UIListComponent> => ({
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

  it("should render a simple list of items", () => {
    const component: A2UIListComponent = {
      id: "list-1",
      component: "List",
      items: ["Item 1", "Item 2", "Item 3"],
    }

    render(<A2UIList {...createProps(component)} />)
    expect(screen.getByText("Item 1")).toBeInTheDocument()
    expect(screen.getByText("Item 2")).toBeInTheDocument()
    expect(screen.getByText("Item 3")).toBeInTheDocument()
  })

  it("should render objects with label property", () => {
    const component: A2UIListComponent = {
      id: "list-2",
      component: "List",
      items: [
        { id: "1", label: "First" },
        { id: "2", label: "Second" },
      ],
    }

    render(<A2UIList {...createProps(component)} />)
    expect(screen.getByText("First")).toBeInTheDocument()
    expect(screen.getByText("Second")).toBeInTheDocument()
  })

  it("should call onAction when item is clicked with itemClickAction", () => {
    const component: A2UIListComponent = {
      id: "list-3",
      component: "List",
      items: ["Clickable Item"],
      itemClickAction: "item-clicked",
    }

    render(<A2UIList {...createProps(component)} />)
    fireEvent.click(screen.getByText("Clickable Item"))

    expect(mockOnAction).toHaveBeenCalledWith(
      "item-clicked",
      expect.objectContaining({
        item: "Clickable Item",
        index: 0,
      })
    )
  })

  it("should render ordered list when ordered is true", () => {
    const component: A2UIListComponent = {
      id: "list-4",
      component: "List",
      items: ["A", "B", "C"],
      ordered: true,
    }

    const { container } = render(<A2UIList {...createProps(component)} />)
    expect(container.querySelector("ul")).toHaveClass("list-decimal")
  })

  it("should apply custom className", () => {
    const component: A2UIListComponent = {
      id: "list-5",
      component: "List",
      items: ["Item"],
      className: "custom-class",
    }

    const { container } = render(<A2UIList {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })

  describe("active item highlighting", () => {
    it("should highlight active item on click", () => {
      const component: A2UIListComponent = {
        id: "list-active",
        component: "List",
        items: ["Item A", "Item B", "Item C"],
        itemClickAction: "select",
      }

      render(<A2UIList {...createProps(component)} />)

      // Click second item
      fireEvent.click(screen.getByText("Item B"))

      // Should call setActiveIndex with the clicked index
      expect(mockSetActiveIndex).toHaveBeenCalledWith(1)
    })

    it("should apply active class to first item by default", () => {
      const component: A2UIListComponent = {
        id: "list-default-active",
        component: "List",
        items: ["First", "Second"],
      }

      const { container } = render(<A2UIList {...createProps(component)} />)
      const firstItem = container.querySelector("li")
      expect(firstItem).toHaveClass("bg-accent/50")
    })
  })

  describe("virtualization for large lists", () => {
    const bigItems = Array.from({ length: 150 }, (_, i) => `Row ${i}`)

    it("renders inline (no virtual container) below the threshold", () => {
      const component: A2UIListComponent = {
        id: "small",
        component: "List",
        items: ["a", "b", "c"],
      }
      render(<A2UIList {...createProps(component)} />)
      expect(screen.queryByTestId("a2ui-list-virtualized")).not.toBeInTheDocument()
      expect(screen.getByText("a")).toBeInTheDocument()
    })

    it("switches to a windowed container above the threshold", () => {
      const component: A2UIListComponent = {
        id: "big",
        component: "List",
        items: bigItems,
      }
      render(<A2UIList {...createProps(component)} />)

      // Virtualized container is present and only the windowed subset mounts.
      expect(screen.getByTestId("a2ui-list-virtualized")).toBeInTheDocument()
      expect(screen.getByText("Row 0")).toBeInTheDocument()
      expect(screen.getByText("Row 4")).toBeInTheDocument()
      // Far-down rows are NOT in the DOM (windowed out).
      expect(screen.queryByText("Row 100")).not.toBeInTheDocument()
      expect(screen.queryByText("Row 149")).not.toBeInTheDocument()
    })

    it("fires itemClickAction from a virtualized row", () => {
      const onAction = jest.fn()
      const component: A2UIListComponent = {
        id: "big-click",
        component: "List",
        items: bigItems,
        itemClickAction: "select",
      }
      render(<A2UIList {...createProps(component)} onAction={onAction} />)

      fireEvent.click(screen.getByText("Row 2"))
      expect(onAction).toHaveBeenCalledWith("select", { item: "Row 2", index: 2 })
    })

    it("renders the children template per windowed row in children mode", () => {
      const component: A2UIListComponent = {
        id: "big-children",
        component: "List",
        items: bigItems,
        children: ["child-1"],
      }
      render(<A2UIList {...createProps(component)} />)

      // One A2UIChildRenderer per windowed row (5), not per full dataset (150).
      expect(screen.getByTestId("a2ui-list-virtualized")).toBeInTheDocument()
      expect(screen.getAllByTestId("children")).toHaveLength(5)
    })

    it("uses the item template per windowed row in template mode", () => {
      const component: A2UIListComponent = {
        id: "big-template",
        component: "List",
        items: bigItems,
        template: { itemId: "tpl-item", dataPath: "" },
      }
      render(<A2UIList {...createProps(component)} />)

      // The template body resolves through the surface renderChild once per
      // windowed row (5), not once per full dataset (150).
      expect(screen.getByTestId("a2ui-list-virtualized")).toBeInTheDocument()
      expect(mockActionsRenderChild).toHaveBeenCalledWith("tpl-item")
      expect(mockActionsRenderChild).toHaveBeenCalledTimes(5)
    })
  })
})
