/**
 * A2UI Slider Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UISlider } from "./a2ui-slider"
import type { A2UISliderComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock the A2UI context
const mockDataCtx = {
  surface: null,
  dataModel: { volume: 50 },
  components: {},
  resolveNumber: (value: number | { path: string }) => {
    if (typeof value === "number") return value
    return 50
  },
  resolveString: (value: string | { path: string }) => (typeof value === "string" ? value : ""),
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

describe("A2UISlider", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UISliderComponent
  ): A2UIComponentProps<A2UISliderComponent> => ({
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

  it("should render a slider", () => {
    const component: A2UISliderComponent = {
      id: "slider-1",
      component: "Slider",
      value: 50,
    }

    render(<A2UISlider {...createProps(component)} />)
    expect(screen.getByRole("slider")).toBeInTheDocument()
  })

  it("should render with label", () => {
    const component: A2UISliderComponent = {
      id: "slider-2",
      component: "Slider",
      value: 50,
      label: "Volume",
    }

    render(<A2UISlider {...createProps(component)} />)
    expect(screen.getByText("Volume")).toBeInTheDocument()
  })

  it("should show value when showValue is true", () => {
    const component: A2UISliderComponent = {
      id: "slider-3",
      component: "Slider",
      value: 50,
      label: "Brightness",
      showValue: true,
    }

    render(<A2UISlider {...createProps(component)} />)
    expect(screen.getByText("50")).toBeInTheDocument()
  })

  it("should apply min/max attributes", () => {
    const component: A2UISliderComponent = {
      id: "slider-4",
      component: "Slider",
      value: 25,
      min: 0,
      max: 100,
    }

    render(<A2UISlider {...createProps(component)} />)
    const slider = screen.getByRole("slider")
    expect(slider).toHaveAttribute("aria-valuemin", "0")
    expect(slider).toHaveAttribute("aria-valuemax", "100")
  })

  it("should apply custom className", () => {
    const component: A2UISliderComponent = {
      id: "slider-5",
      component: "Slider",
      value: 50,
      className: "custom-class",
    }

    const { container } = render(<A2UISlider {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })
})
