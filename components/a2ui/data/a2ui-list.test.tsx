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

// Mock the A2UI renderer
jest.mock("../a2ui-renderer", () => ({
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
})
