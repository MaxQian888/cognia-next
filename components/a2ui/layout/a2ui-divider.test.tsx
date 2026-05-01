/**
 * A2UI Divider Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIDivider } from "./a2ui-divider"
import type { A2UIDividerComponent, A2UIComponentProps } from "@/types/a2ui/schema"

describe("A2UIDivider", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UIDividerComponent
  ): A2UIComponentProps<A2UIDividerComponent> => ({
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

  it("should render a horizontal divider by default", () => {
    const component: A2UIDividerComponent = {
      id: "divider-1",
      component: "Divider",
    }

    const { container } = render(<A2UIDivider {...createProps(component)} />)
    expect(container.querySelector('[data-orientation="horizontal"]')).toBeInTheDocument()
  })

  it("should render a vertical divider when specified", () => {
    const component: A2UIDividerComponent = {
      id: "divider-2",
      component: "Divider",
      orientation: "vertical",
    }

    const { container } = render(<A2UIDivider {...createProps(component)} />)
    expect(container.querySelector('[data-orientation="vertical"]')).toBeInTheDocument()
  })

  it("should render with text when provided", () => {
    const component: A2UIDividerComponent = {
      id: "divider-3",
      component: "Divider",
      text: "OR",
    }

    render(<A2UIDivider {...createProps(component)} />)
    expect(screen.getByText("OR")).toBeInTheDocument()
  })

  it("should apply custom className", () => {
    const component: A2UIDividerComponent = {
      id: "divider-4",
      component: "Divider",
      className: "custom-class",
    }

    const { container } = render(<A2UIDivider {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })
})
