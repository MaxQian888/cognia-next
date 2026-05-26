/**
 * A2UI Row Component Tests
 */

import React from "react"
import { render } from "@testing-library/react"
import { A2UIRow } from "./a2ui-row"
import type { A2UIRowComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock the A2UI renderer
jest.mock("../a2ui-child-renderer", () => ({
  A2UIChildRenderer: ({ childIds }: { childIds: string[] }) => (
    <div data-testid="children">{childIds.join(",")}</div>
  ),
}))

describe("A2UIRow", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UIRowComponent): A2UIComponentProps<A2UIRowComponent> => ({
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

  it("should render a flex row container", () => {
    const component: A2UIRowComponent = {
      id: "row-1",
      component: "Row",
      children: ["child-1", "child-2"],
    }

    const { container } = render(<A2UIRow {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("flex", "flex-row")
  })

  it("should apply alignment styles", () => {
    const component: A2UIRowComponent = {
      id: "row-2",
      component: "Row",
      children: [],
      align: "center",
      justify: "between",
    }

    const { container } = render(<A2UIRow {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("items-center", "justify-between")
  })

  it("should apply wrap style when enabled", () => {
    const component: A2UIRowComponent = {
      id: "row-3",
      component: "Row",
      children: [],
      wrap: true,
    }

    const { container } = render(<A2UIRow {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("flex-wrap")
  })

  it("should apply custom className", () => {
    const component: A2UIRowComponent = {
      id: "row-4",
      component: "Row",
      children: [],
      className: "custom-class",
    }

    const { container } = render(<A2UIRow {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })

  it("should apply numeric gap as inline style", () => {
    const component: A2UIRowComponent = {
      id: "row-5",
      component: "Row",
      children: [],
      gap: 16,
    }

    const { container } = render(<A2UIRow {...createProps(component)} />)
    expect(container.firstChild).toHaveStyle({ gap: "16px" })
  })
})
