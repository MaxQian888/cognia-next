/**
 * A2UI Progress Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIProgress } from "./a2ui-progress"
import type { A2UIProgressComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock the A2UI context
const mockDataCtx = {
  surface: null,
  dataModel: { progress: 50 },
  components: {},
  resolveNumber: (value: number | { path: string }) => {
    if (typeof value === "number") return value
    return 50
  },
  resolveString: (value: string | { path: string }) => (typeof value === "string" ? value : ""),
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

describe("A2UIProgress", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UIProgressComponent
  ): A2UIComponentProps<A2UIProgressComponent> => ({
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

  it("should render progress bar", () => {
    const component: A2UIProgressComponent = {
      id: "progress-1",
      component: "Progress",
      value: 50,
    }

    render(<A2UIProgress {...createProps(component)} />)
    expect(screen.getByRole("progressbar")).toBeInTheDocument()
  })

  it("should render with label", () => {
    const component: A2UIProgressComponent = {
      id: "progress-2",
      component: "Progress",
      value: 75,
      label: "Download progress",
    }

    render(<A2UIProgress {...createProps(component)} />)
    expect(screen.getByText("Download progress")).toBeInTheDocument()
  })

  it("should show value when showValue is true", () => {
    const component: A2UIProgressComponent = {
      id: "progress-3",
      component: "Progress",
      value: 30,
      max: 100,
      showValue: true,
    }

    render(<A2UIProgress {...createProps(component)} />)
    expect(screen.getByText("30 / 100")).toBeInTheDocument()
  })

  it("should respect custom max value", () => {
    const component: A2UIProgressComponent = {
      id: "progress-4",
      component: "Progress",
      value: 50,
      max: 200,
      showValue: true,
    }

    render(<A2UIProgress {...createProps(component)} />)
    expect(screen.getByText("50 / 200")).toBeInTheDocument()
  })

  it("should apply custom className", () => {
    const component: A2UIProgressComponent = {
      id: "progress-5",
      component: "Progress",
      value: 60,
      className: "custom-progress",
    }

    const { container } = render(<A2UIProgress {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-progress")
  })
})
