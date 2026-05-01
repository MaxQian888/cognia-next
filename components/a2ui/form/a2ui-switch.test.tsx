/**
 * A2UI Switch Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UISwitch, A2UISwitchComponent } from "./a2ui-switch"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

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

describe("A2UISwitch", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UISwitchComponent
  ): A2UIComponentProps<A2UISwitchComponent> => ({
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

  it("should render a switch", () => {
    const component: A2UISwitchComponent = {
      id: "switch-1",
      component: "Switch",
      checked: false,
    }

    render(<A2UISwitch {...createProps(component)} />)
    expect(screen.getByRole("switch")).toBeInTheDocument()
  })

  it("should render with label", () => {
    const component: A2UISwitchComponent = {
      id: "switch-2",
      component: "Switch",
      checked: false,
      label: "Enable notifications",
    }

    render(<A2UISwitch {...createProps(component)} />)
    expect(screen.getByText("Enable notifications")).toBeInTheDocument()
  })

  it("should render with description", () => {
    const component: A2UISwitchComponent = {
      id: "switch-3",
      component: "Switch",
      checked: false,
      label: "Dark Mode",
      description: "Enable dark mode theme",
    }

    render(<A2UISwitch {...createProps(component)} />)
    expect(screen.getByText("Enable dark mode theme")).toBeInTheDocument()
  })

  it("should call onDataChange when toggled", () => {
    const component: A2UISwitchComponent = {
      id: "switch-4",
      component: "Switch",
      checked: { path: "/settings/darkMode" },
    }

    render(<A2UISwitch {...createProps(component)} />)
    fireEvent.click(screen.getByRole("switch"))

    expect(mockOnDataChange).toHaveBeenCalledWith("/settings/darkMode", true)
  })

  it("should apply custom className", () => {
    const component: A2UISwitchComponent = {
      id: "switch-5",
      component: "Switch",
      checked: false,
      className: "custom-class",
    }

    const { container } = render(<A2UISwitch {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })
})
