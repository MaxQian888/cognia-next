/**
 * A2UI TextArea Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UITextArea } from "./a2ui-textarea"
import type { A2UITextAreaComponent, A2UIComponentProps } from "@/types/a2ui/schema"

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

// Mock getBindingPath
jest.mock("@/lib/a2ui/data-model", () => ({
  getBindingPath: (value: unknown) => {
    if (typeof value === "object" && value !== null && "path" in value) {
      return (value as { path: string }).path
    }
    return undefined
  },
}))

describe("A2UITextArea", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UITextAreaComponent
  ): A2UIComponentProps<A2UITextAreaComponent> => ({
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

  it("should render a textarea", () => {
    const component: A2UITextAreaComponent = {
      id: "textarea-1",
      component: "TextArea",
      value: "Initial text",
    }

    render(<A2UITextArea {...createProps(component)} />)
    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })

  it("should render with label", () => {
    const component: A2UITextAreaComponent = {
      id: "textarea-2",
      component: "TextArea",
      value: "",
      label: "Description",
    }

    render(<A2UITextArea {...createProps(component)} />)
    expect(screen.getByText("Description")).toBeInTheDocument()
  })

  it("should render with placeholder", () => {
    const component: A2UITextAreaComponent = {
      id: "textarea-3",
      component: "TextArea",
      value: "",
      placeholder: "Enter description...",
    }

    render(<A2UITextArea {...createProps(component)} />)
    expect(screen.getByPlaceholderText("Enter description...")).toBeInTheDocument()
  })

  it("should call onDataChange when text changes", () => {
    const component: A2UITextAreaComponent = {
      id: "textarea-4",
      component: "TextArea",
      value: { path: "/description" },
    }

    render(<A2UITextArea {...createProps(component)} />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New text" } })

    expect(mockOnDataChange).toHaveBeenCalledWith("/description", "New text")
  })

  it("should show required indicator", () => {
    const component: A2UITextAreaComponent = {
      id: "textarea-5",
      component: "TextArea",
      value: "",
      label: "Required Field",
      required: true,
    }

    render(<A2UITextArea {...createProps(component)} />)
    expect(screen.getByText("*")).toBeInTheDocument()
  })
})
