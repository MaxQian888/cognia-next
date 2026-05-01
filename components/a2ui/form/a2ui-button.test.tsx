/**
 * A2UI Button Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UIButton } from "./a2ui-button"
import type { A2UIButtonComponent, A2UIComponentProps } from "@/types/a2ui/schema"

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

describe("A2UIButton", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UIButtonComponent
  ): A2UIComponentProps<A2UIButtonComponent> => ({
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

  it("should render button with label", () => {
    const component: A2UIButtonComponent = {
      id: "btn-1",
      component: "Button",
      text: "Click Me",
      action: "submit",
    }

    render(<A2UIButton {...createProps(component)} />)
    expect(screen.getByRole("button", { name: "Click Me" })).toBeInTheDocument()
  })

  it("should call onAction when clicked", () => {
    const component: A2UIButtonComponent = {
      id: "btn-2",
      component: "Button",
      text: "Submit",
      action: "submit",
    }

    render(<A2UIButton {...createProps(component)} />)
    fireEvent.click(screen.getByRole("button"))

    expect(mockOnAction).toHaveBeenCalledWith("submit", expect.any(Object))
  })

  it("should be disabled when disabled prop is true", () => {
    const component: A2UIButtonComponent = {
      id: "btn-3",
      component: "Button",
      text: "Disabled",
      action: "submit",
      disabled: true,
    }

    render(<A2UIButton {...createProps(component)} />)
    expect(screen.getByRole("button")).toBeDisabled()
  })

  it("should not call onAction when disabled", () => {
    const component: A2UIButtonComponent = {
      id: "btn-4",
      component: "Button",
      text: "Disabled",
      action: "submit",
      disabled: true,
    }

    render(<A2UIButton {...createProps(component)} />)
    fireEvent.click(screen.getByRole("button"))

    expect(mockOnAction).not.toHaveBeenCalled()
  })

  it("should render with different variants", () => {
    const component: A2UIButtonComponent = {
      id: "btn-5",
      component: "Button",
      text: "Secondary",
      action: "cancel",
      variant: "secondary",
    }

    render(<A2UIButton {...createProps(component)} />)
    expect(screen.getByRole("button")).toBeInTheDocument()
  })

  it("should show loading state", () => {
    const component: A2UIButtonComponent = {
      id: "btn-6",
      component: "Button",
      text: "Loading",
      action: "submit",
      loading: true,
    }

    render(<A2UIButton {...createProps(component)} />)
    expect(screen.getByRole("button")).toBeDisabled()
  })
})
