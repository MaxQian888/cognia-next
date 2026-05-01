/**
 * A2UI Checkbox Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UICheckbox } from "./a2ui-checkbox"
import type { A2UICheckboxComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock the A2UI context
const mockDataCtx = {
  surface: null,
  dataModel: { agreed: true },
  components: {},
  resolveBoolean: (value: boolean | { path: string }) => {
    if (typeof value === "boolean") return value
    return false
  },
  resolveString: (value: string | { path: string }) => (typeof value === "string" ? value : ""),
  resolveNumber: (value: number | { path: string }) => (typeof value === "number" ? value : 0),
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

describe("A2UICheckbox", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UICheckboxComponent
  ): A2UIComponentProps<A2UICheckboxComponent> => ({
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

  it("should render checkbox", () => {
    const component: A2UICheckboxComponent = {
      id: "checkbox-1",
      component: "Checkbox",
      checked: false,
    }

    render(<A2UICheckbox {...createProps(component)} />)
    expect(screen.getByRole("checkbox")).toBeInTheDocument()
  })

  it("should render with label", () => {
    const component: A2UICheckboxComponent = {
      id: "checkbox-2",
      component: "Checkbox",
      checked: false,
      label: "Accept terms",
    }

    render(<A2UICheckbox {...createProps(component)} />)
    expect(screen.getByText("Accept terms")).toBeInTheDocument()
  })

  it("should be checked when checked prop is true", () => {
    const component: A2UICheckboxComponent = {
      id: "checkbox-3",
      component: "Checkbox",
      checked: true,
    }

    render(<A2UICheckbox {...createProps(component)} />)
    expect(screen.getByRole("checkbox")).toBeChecked()
  })

  it("should call onDataChange when toggled", () => {
    const component: A2UICheckboxComponent = {
      id: "checkbox-4",
      component: "Checkbox",
      checked: { path: "/agreed" },
    }

    render(<A2UICheckbox {...createProps(component)} />)
    fireEvent.click(screen.getByRole("checkbox"))

    expect(mockOnDataChange).toHaveBeenCalledWith("/agreed", true)
  })

  it("should be disabled when disabled prop is true", () => {
    const component: A2UICheckboxComponent = {
      id: "checkbox-5",
      component: "Checkbox",
      checked: false,
      disabled: true,
    }

    render(<A2UICheckbox {...createProps(component)} />)
    expect(screen.getByRole("checkbox")).toBeDisabled()
  })

  it("should render helper text", () => {
    const component: A2UICheckboxComponent = {
      id: "checkbox-6",
      component: "Checkbox",
      checked: false,
      label: "Newsletter",
      helperText: "Receive weekly updates",
    }

    render(<A2UICheckbox {...createProps(component)} />)
    expect(screen.getByText("Receive weekly updates")).toBeInTheDocument()
  })
})
