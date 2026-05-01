/**
 * A2UI Spacer Component Tests
 */

import React from "react"
import { render } from "@testing-library/react"
import { A2UISpacer } from "./a2ui-spacer"
import type { A2UISpacerComponent, A2UIComponentProps } from "@/types/a2ui/schema"

describe("A2UISpacer", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UISpacerComponent
  ): A2UIComponentProps<A2UISpacerComponent> => ({
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

  it("should render with default size", () => {
    const component: A2UISpacerComponent = {
      id: "spacer-1",
      component: "Spacer",
    }

    const { container } = render(<A2UISpacer {...createProps(component)} />)
    expect(container.firstChild).toHaveStyle({
      width: "16px",
      height: "16px",
    })
  })

  it("should render with custom numeric size", () => {
    const component: A2UISpacerComponent = {
      id: "spacer-2",
      component: "Spacer",
      size: 32,
    }

    const { container } = render(<A2UISpacer {...createProps(component)} />)
    expect(container.firstChild).toHaveStyle({
      width: "32px",
      height: "32px",
    })
  })

  it("should render with string size", () => {
    const component: A2UISpacerComponent = {
      id: "spacer-3",
      component: "Spacer",
      size: "2rem",
    }

    const { container } = render(<A2UISpacer {...createProps(component)} />)
    expect(container.firstChild).toHaveStyle({
      width: "2rem",
      height: "2rem",
    })
  })

  it("should have aria-hidden attribute", () => {
    const component: A2UISpacerComponent = {
      id: "spacer-4",
      component: "Spacer",
    }

    const { container } = render(<A2UISpacer {...createProps(component)} />)
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true")
  })
})
