/**
 * A2UI Loading Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UILoading, A2UILoadingComponent } from "./a2ui-loading"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

describe("A2UILoading", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UILoadingComponent
  ): A2UIComponentProps<A2UILoadingComponent> => ({
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

  it("should render a spinner by default", () => {
    const component: A2UILoadingComponent = {
      id: "loading-1",
      component: "Loading",
    }

    const { container } = render(<A2UILoading {...createProps(component)} />)
    expect(container.querySelector("svg")).toBeInTheDocument()
  })

  it("should render with text", () => {
    const component: A2UILoadingComponent = {
      id: "loading-2",
      component: "Loading",
      text: "Loading data...",
    }

    render(<A2UILoading {...createProps(component)} />)
    expect(screen.getByText("Loading data...")).toBeInTheDocument()
  })

  it("should have status role", () => {
    const component: A2UILoadingComponent = {
      id: "loading-3",
      component: "Loading",
    }

    render(<A2UILoading {...createProps(component)} />)
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("should apply custom className", () => {
    const component: A2UILoadingComponent = {
      id: "loading-4",
      component: "Loading",
      className: "custom-class",
    }

    const { container } = render(<A2UILoading {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })
})
