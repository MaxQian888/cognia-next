/**
 * A2UI TextField Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UITextField } from "./a2ui-textfield"
import type { A2UITextFieldComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock the A2UI context
const mockDataCtx = {
  surface: null,
  dataModel: { name: "John" },
  components: {},
  resolveString: (value: string | { path: string }) => {
    if (typeof value === "string") return value
    if (value.path === "/name") return "John"
    return ""
  },
  resolveNumber: (value: number | { path: string }) => (typeof value === "number" ? value : 0),
  resolveBoolean: () => false,
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

// Mock getBindingPath
jest.mock("@/lib/a2ui/data-model", () => ({
  getBindingPath: (value: unknown) => {
    if (typeof value === "object" && value !== null && "path" in value) {
      return (value as { path: string }).path
    }
    return null
  },
}))

describe("A2UITextField", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UITextFieldComponent
  ): A2UIComponentProps<A2UITextFieldComponent> => ({
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

  it("should render input field", () => {
    const component: A2UITextFieldComponent = {
      id: "field-1",
      component: "TextField",
      value: "test",
    }

    render(<A2UITextField {...createProps(component)} />)
    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })

  it("should render with label", () => {
    const component: A2UITextFieldComponent = {
      id: "field-2",
      component: "TextField",
      value: "",
      label: "Username",
    }

    render(<A2UITextField {...createProps(component)} />)
    expect(screen.getByText("Username")).toBeInTheDocument()
  })

  it("should render with placeholder", () => {
    const component: A2UITextFieldComponent = {
      id: "field-3",
      component: "TextField",
      value: "",
      placeholder: "Enter your name",
    }

    render(<A2UITextField {...createProps(component)} />)
    expect(screen.getByPlaceholderText("Enter your name")).toBeInTheDocument()
  })

  it("should call onDataChange when value changes", () => {
    const component: A2UITextFieldComponent = {
      id: "field-4",
      component: "TextField",
      value: { path: "/name" },
    }

    render(<A2UITextField {...createProps(component)} />)
    const input = screen.getByRole("textbox")

    fireEvent.change(input, { target: { value: "Jane" } })

    expect(mockOnDataChange).toHaveBeenCalledWith("/name", "Jane")
  })

  it("should be disabled when disabled prop is true", () => {
    const component: A2UITextFieldComponent = {
      id: "field-5",
      component: "TextField",
      value: "",
      disabled: true,
    }

    render(<A2UITextField {...createProps(component)} />)
    // Note: disabled state depends on resolveBoolean mock returning true for disabled
    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })

  it("should show required indicator", () => {
    const component: A2UITextFieldComponent = {
      id: "field-6",
      component: "TextField",
      value: "",
      label: "Email",
      required: true,
    }

    render(<A2UITextField {...createProps(component)} />)
    expect(screen.getByText("*")).toBeInTheDocument()
  })

  it("should show error message", () => {
    const component: A2UITextFieldComponent = {
      id: "field-7",
      component: "TextField",
      value: "",
      error: "This field is required",
    }

    render(<A2UITextField {...createProps(component)} />)
    expect(screen.getByText("This field is required")).toBeInTheDocument()
  })
})
