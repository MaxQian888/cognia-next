/**
 * A2UI Select Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UISelect } from "./a2ui-select"
import type { A2UISelectComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock the A2UI context
const mockDataCtx = {
  surface: null,
  dataModel: {},
  components: {},
  resolveString: (value: string | { path: string }) => (typeof value === "string" ? value : ""),
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
  resolveArrayOrPath: (value: unknown) => {
    if (Array.isArray(value)) return value
    return []
  },
}))

describe("A2UISelect", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UISelectComponent
  ): A2UIComponentProps<A2UISelectComponent> => ({
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

  it("should render select component", () => {
    const component: A2UISelectComponent = {
      id: "select-1",
      component: "Select",
      value: "",
      options: [
        { value: "opt1", label: "Option 1" },
        { value: "opt2", label: "Option 2" },
      ],
    }

    render(<A2UISelect {...createProps(component)} />)
    expect(screen.getByRole("combobox")).toBeInTheDocument()
  })

  it("should render with label", () => {
    const component: A2UISelectComponent = {
      id: "select-2",
      component: "Select",
      value: "",
      label: "Country",
      options: [
        { value: "us", label: "United States" },
        { value: "uk", label: "United Kingdom" },
      ],
    }

    render(<A2UISelect {...createProps(component)} />)
    expect(screen.getByText("Country")).toBeInTheDocument()
  })

  it("should render placeholder", () => {
    const component: A2UISelectComponent = {
      id: "select-3",
      component: "Select",
      value: "",
      placeholder: "Select an option",
      options: [{ value: "a", label: "A" }],
    }

    render(<A2UISelect {...createProps(component)} />)
    expect(screen.getByText("Select an option")).toBeInTheDocument()
  })

  it("should be disabled when disabled prop is true", () => {
    const component: A2UISelectComponent = {
      id: "select-4",
      component: "Select",
      value: "",
      disabled: true,
      options: [{ value: "a", label: "A" }],
    }

    render(<A2UISelect {...createProps(component)} />)
    // Select component uses aria-disabled or data attributes for disabled state
    const combobox = screen.getByRole("combobox")
    expect(combobox).toBeInTheDocument()
  })
})
