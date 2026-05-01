/**
 * A2UI Empty Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UIEmpty, A2UIEmptyComponent } from "./a2ui-empty"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

describe("A2UIEmpty", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UIEmptyComponent): A2UIComponentProps<A2UIEmptyComponent> => ({
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

  it("should render an empty icon", () => {
    const component: A2UIEmptyComponent = {
      id: "empty-1",
      component: "Empty",
    }

    const { container } = render(<A2UIEmpty {...createProps(component)} />)
    expect(container.querySelector("svg")).toBeInTheDocument()
  })

  it("should render title and message", () => {
    const component: A2UIEmptyComponent = {
      id: "empty-2",
      component: "Empty",
      title: "No items",
      message: "Add your first item to get started",
    }

    render(<A2UIEmpty {...createProps(component)} />)
    expect(screen.getByText("No items")).toBeInTheDocument()
    expect(screen.getByText("Add your first item to get started")).toBeInTheDocument()
  })

  it("should render action button when action is provided", () => {
    const component: A2UIEmptyComponent = {
      id: "empty-3",
      component: "Empty",
      actionLabel: "Add Item",
      action: "add-item",
    }

    render(<A2UIEmpty {...createProps(component)} />)
    expect(screen.getByText("Add Item")).toBeInTheDocument()
  })

  it("should call onAction when button is clicked", () => {
    const component: A2UIEmptyComponent = {
      id: "empty-4",
      component: "Empty",
      actionLabel: "Create",
      action: "create",
    }

    render(<A2UIEmpty {...createProps(component)} />)
    fireEvent.click(screen.getByText("Create"))

    expect(mockOnAction).toHaveBeenCalledWith("create", {})
  })

  it("should apply custom className", () => {
    const component: A2UIEmptyComponent = {
      id: "empty-5",
      component: "Empty",
      className: "custom-class",
    }

    const { container } = render(<A2UIEmpty {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })
})
