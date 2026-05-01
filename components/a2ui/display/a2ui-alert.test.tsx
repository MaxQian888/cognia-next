/**
 * A2UI Alert Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UIAlert } from "./a2ui-alert"
import type { A2UIAlertComponent, A2UIComponentProps } from "@/types/a2ui/schema"

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

describe("A2UIAlert", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UIAlertComponent): A2UIComponentProps<A2UIAlertComponent> => ({
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

  it("should render alert with message", () => {
    const component: A2UIAlertComponent = {
      id: "alert-1",
      component: "Alert",
      message: "This is an alert message",
    }

    render(<A2UIAlert {...createProps(component)} />)
    expect(screen.getByText("This is an alert message")).toBeInTheDocument()
  })

  it("should render with title", () => {
    const component: A2UIAlertComponent = {
      id: "alert-2",
      component: "Alert",
      title: "Warning",
      message: "Something went wrong",
    }

    render(<A2UIAlert {...createProps(component)} />)
    expect(screen.getByText("Warning")).toBeInTheDocument()
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
  })

  it("should render info variant", () => {
    const component: A2UIAlertComponent = {
      id: "alert-3",
      component: "Alert",
      message: "Info message",
      variant: "info",
    }

    render(<A2UIAlert {...createProps(component)} />)
    expect(screen.getByText("Info message")).toBeInTheDocument()
  })

  it("should render success variant", () => {
    const component: A2UIAlertComponent = {
      id: "alert-4",
      component: "Alert",
      message: "Success!",
      variant: "success",
    }

    render(<A2UIAlert {...createProps(component)} />)
    expect(screen.getByText("Success!")).toBeInTheDocument()
  })

  it("should render warning variant", () => {
    const component: A2UIAlertComponent = {
      id: "alert-5",
      component: "Alert",
      message: "Warning!",
      variant: "warning",
    }

    render(<A2UIAlert {...createProps(component)} />)
    expect(screen.getByText("Warning!")).toBeInTheDocument()
  })

  it("should render error variant", () => {
    const component: A2UIAlertComponent = {
      id: "alert-6",
      component: "Alert",
      message: "Error occurred",
      variant: "error",
    }

    render(<A2UIAlert {...createProps(component)} />)
    expect(screen.getByText("Error occurred")).toBeInTheDocument()
  })

  it("should be dismissible when dismissible prop is true", () => {
    const component: A2UIAlertComponent = {
      id: "alert-7",
      component: "Alert",
      message: "Dismissible alert",
      dismissible: true,
      dismissAction: "dismiss",
    }

    render(<A2UIAlert {...createProps(component)} />)
    const dismissButton = screen.getByRole("button")
    expect(dismissButton).toBeInTheDocument()
  })

  it("should call onAction when dismissed", () => {
    const component: A2UIAlertComponent = {
      id: "alert-8",
      component: "Alert",
      message: "Dismissible alert",
      dismissible: true,
      dismissAction: "dismiss-alert",
    }

    render(<A2UIAlert {...createProps(component)} />)
    fireEvent.click(screen.getByRole("button"))

    expect(mockOnAction).toHaveBeenCalledWith("dismiss-alert", {})
  })
})
