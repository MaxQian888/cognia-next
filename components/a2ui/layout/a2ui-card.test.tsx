/**
 * A2UI Card Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UICard } from "./a2ui-card"
import type { A2UICardComponent, A2UIComponentProps } from "@/types/a2ui/schema"

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

// Mock the A2UI renderer
jest.mock("../a2ui-child-renderer", () => ({
  A2UIChildRenderer: ({ childIds }: { childIds: string[] }) => (
    <div data-testid="children">{childIds.join(",")}</div>
  ),
}))

describe("A2UICard", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UICardComponent): A2UIComponentProps<A2UICardComponent> => ({
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

  it("should render a card with title", () => {
    const component: A2UICardComponent = {
      id: "card-1",
      component: "Card",
      title: "Card Title",
    }

    render(<A2UICard {...createProps(component)} />)
    expect(screen.getByText("Card Title")).toBeInTheDocument()
  })

  it("should render a card with description", () => {
    const component: A2UICardComponent = {
      id: "card-2",
      component: "Card",
      title: "Title",
      description: "Card Description",
    }

    render(<A2UICard {...createProps(component)} />)
    expect(screen.getByText("Card Description")).toBeInTheDocument()
  })

  it("should call onAction when clicked with clickAction", () => {
    const component: A2UICardComponent = {
      id: "card-3",
      component: "Card",
      title: "Clickable Card",
      clickAction: "card-clicked",
    }

    render(<A2UICard {...createProps(component)} />)
    fireEvent.click(screen.getByText("Clickable Card"))

    expect(mockOnAction).toHaveBeenCalledWith("card-clicked", expect.any(Object))
  })

  it("should apply custom className", () => {
    const component: A2UICardComponent = {
      id: "card-4",
      component: "Card",
      title: "Styled Card",
      className: "custom-class",
    }

    const { container } = render(<A2UICard {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })
})
