/**
 * A2UI Badge Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIBadge } from "./a2ui-badge"
import type { A2UIBadgeComponent, A2UIComponentProps } from "@/types/a2ui/schema"

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

describe("A2UIBadge", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UIBadgeComponent): A2UIComponentProps<A2UIBadgeComponent> => ({
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

  it("should render badge with text", () => {
    const component: A2UIBadgeComponent = {
      id: "badge-1",
      component: "Badge",
      text: "New",
    }

    render(<A2UIBadge {...createProps(component)} />)
    expect(screen.getByText("New")).toBeInTheDocument()
  })

  it("should render default variant", () => {
    const component: A2UIBadgeComponent = {
      id: "badge-2",
      component: "Badge",
      text: "Default",
      variant: "default",
    }

    render(<A2UIBadge {...createProps(component)} />)
    expect(screen.getByText("Default")).toBeInTheDocument()
  })

  it("should render secondary variant", () => {
    const component: A2UIBadgeComponent = {
      id: "badge-3",
      component: "Badge",
      text: "Secondary",
      variant: "secondary",
    }

    render(<A2UIBadge {...createProps(component)} />)
    expect(screen.getByText("Secondary")).toBeInTheDocument()
  })

  it("should render destructive variant", () => {
    const component: A2UIBadgeComponent = {
      id: "badge-4",
      component: "Badge",
      text: "Error",
      variant: "destructive",
    }

    render(<A2UIBadge {...createProps(component)} />)
    expect(screen.getByText("Error")).toBeInTheDocument()
  })

  it("should render outline variant", () => {
    const component: A2UIBadgeComponent = {
      id: "badge-5",
      component: "Badge",
      text: "Outline",
      variant: "outline",
    }

    render(<A2UIBadge {...createProps(component)} />)
    expect(screen.getByText("Outline")).toBeInTheDocument()
  })

  it("should apply custom className", () => {
    const component: A2UIBadgeComponent = {
      id: "badge-6",
      component: "Badge",
      text: "Custom",
      className: "custom-badge",
    }

    const { container } = render(<A2UIBadge {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-badge")
  })
})
