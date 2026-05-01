/**
 * A2UI Toggle Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UIToggle } from "./a2ui-toggle"
import type { A2UIToggleComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock the A2UI context
const mockDataCtx = {
  surface: null,
  dataModel: { isActive: true },
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

// Mock data-model resolvers
jest.mock("@/lib/a2ui/data-model", () => ({
  resolveStringOrPath: (value: string | { path: string }, _dm: unknown, def: string) =>
    typeof value === "string" ? value : def,
  resolveBooleanOrPath: (
    value: boolean | { path: string },
    dm: Record<string, unknown>,
    def: boolean
  ) => {
    if (typeof value === "boolean") return value
    if (typeof value === "object" && "path" in value) {
      const key = value.path.replace(/^\//, "")
      return (dm as Record<string, unknown>)[key] ?? def
    }
    return def
  },
}))

describe("A2UIToggle", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UIToggleComponent
  ): A2UIComponentProps<A2UIToggleComponent> => ({
    component,
    surfaceId: "test-surface",
    dataModel: { isActive: true },
    onAction: mockOnAction,
    onDataChange: mockOnDataChange,
    renderChild: mockRenderChild,
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should render toggle with label", () => {
    const component: A2UIToggleComponent = {
      id: "toggle-1",
      component: "Toggle",
      label: "Bold",
    }

    render(<A2UIToggle {...createProps(component)} />)
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument()
  })

  it("should render toggle without label using id as aria-label", () => {
    const component: A2UIToggleComponent = {
      id: "toggle-2",
      component: "Toggle",
    }

    render(<A2UIToggle {...createProps(component)} />)
    expect(screen.getByRole("button", { name: "toggle-2" })).toBeInTheDocument()
  })

  it("should fire action on press change", () => {
    const component: A2UIToggleComponent = {
      id: "toggle-3",
      component: "Toggle",
      label: "Enable",
      action: "toggle_feature",
    }

    render(<A2UIToggle {...createProps(component)} />)
    fireEvent.click(screen.getByRole("button"))

    expect(mockOnAction).toHaveBeenCalledWith("toggle_feature", { pressed: true })
  })

  it("should update data model when pressed with bound path", () => {
    const component: A2UIToggleComponent = {
      id: "toggle-4",
      component: "Toggle",
      label: "Active",
      pressed: { path: "/isActive" },
    }

    render(<A2UIToggle {...createProps(component)} />)
    fireEvent.click(screen.getByRole("button"))

    expect(mockOnDataChange).toHaveBeenCalledWith("/isActive", expect.any(Boolean))
  })

  it("should render as disabled", () => {
    const component: A2UIToggleComponent = {
      id: "toggle-5",
      component: "Toggle",
      label: "Disabled",
      disabled: true,
    }

    render(<A2UIToggle {...createProps(component)} />)
    expect(screen.getByRole("button")).toBeDisabled()
  })
})
