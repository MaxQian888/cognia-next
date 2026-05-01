/**
 * A2UI RadioGroup Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIRadioGroup } from "./a2ui-radio"
import type { A2UIRadioGroupComponent, A2UIComponentProps } from "@/types/a2ui/schema"

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
    return undefined
  },
}))

describe("A2UIRadioGroup", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UIRadioGroupComponent
  ): A2UIComponentProps<A2UIRadioGroupComponent> => ({
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

  it("should render radio options", () => {
    const component: A2UIRadioGroupComponent = {
      id: "radio-1",
      component: "RadioGroup",
      value: "option1",
      options: [
        { value: "option1", label: "Option 1" },
        { value: "option2", label: "Option 2" },
        { value: "option3", label: "Option 3" },
      ],
    }

    render(<A2UIRadioGroup {...createProps(component)} />)
    expect(screen.getByText("Option 1")).toBeInTheDocument()
    expect(screen.getByText("Option 2")).toBeInTheDocument()
    expect(screen.getByText("Option 3")).toBeInTheDocument()
  })

  it("should render with label", () => {
    const component: A2UIRadioGroupComponent = {
      id: "radio-2",
      component: "RadioGroup",
      value: "",
      label: "Select an option",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    }

    render(<A2UIRadioGroup {...createProps(component)} />)
    expect(screen.getByText("Select an option")).toBeInTheDocument()
  })

  it("should render radio buttons", () => {
    const component: A2UIRadioGroupComponent = {
      id: "radio-3",
      component: "RadioGroup",
      value: "yes",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    }

    render(<A2UIRadioGroup {...createProps(component)} />)
    const radios = screen.getAllByRole("radio")
    expect(radios).toHaveLength(2)
  })

  it("should apply custom className", () => {
    const component: A2UIRadioGroupComponent = {
      id: "radio-4",
      component: "RadioGroup",
      value: "",
      options: [{ value: "a", label: "A" }],
      className: "custom-class",
    }

    const { container } = render(<A2UIRadioGroup {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })
})
