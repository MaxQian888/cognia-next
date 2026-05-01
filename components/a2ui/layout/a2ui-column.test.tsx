/**
 * A2UI Column Component Tests
 */

import React from "react"
import { render } from "@testing-library/react"
import { A2UIColumn } from "./a2ui-column"
import type { A2UIColumnComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock the A2UI renderer
jest.mock("../a2ui-renderer", () => ({
  A2UIChildRenderer: ({ childIds }: { childIds: string[] }) => (
    <div data-testid="children">{childIds.join(",")}</div>
  ),
}))

describe("A2UIColumn", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UIColumnComponent
  ): A2UIComponentProps<A2UIColumnComponent> => ({
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

  it("should render a flex column container", () => {
    const component: A2UIColumnComponent = {
      id: "col-1",
      component: "Column",
      children: ["child-1", "child-2"],
    }

    const { container } = render(<A2UIColumn {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("flex", "flex-col")
  })

  it("should apply alignment styles", () => {
    const component: A2UIColumnComponent = {
      id: "col-2",
      component: "Column",
      children: [],
      align: "center",
    }

    const { container } = render(<A2UIColumn {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("items-center")
  })

  it("should apply custom className", () => {
    const component: A2UIColumnComponent = {
      id: "col-3",
      component: "Column",
      children: [],
      className: "custom-class",
    }

    const { container } = render(<A2UIColumn {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })

  it("should apply numeric gap as inline style", () => {
    const component: A2UIColumnComponent = {
      id: "col-4",
      component: "Column",
      children: [],
      gap: 24,
    }

    const { container } = render(<A2UIColumn {...createProps(component)} />)
    expect(container.firstChild).toHaveStyle({ gap: "24px" })
  })
})
