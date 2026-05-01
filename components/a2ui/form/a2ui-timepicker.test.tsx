/**
 * A2UI TimePicker Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UITimePicker } from "./a2ui-timepicker"
import type { A2UITimePickerComponent } from "@/types/a2ui/schema"

// Mock the context
const mockDataCtx = {
  surface: null,
  dataModel: {},
  components: {},
  resolveString: jest.fn((value: unknown) => (typeof value === "string" ? value : "")),
  resolveNumber: jest.fn((value: unknown) => (typeof value === "number" ? value : 0)),
  resolveBoolean: jest.fn((value: unknown, d: unknown) => (typeof value === "boolean" ? value : d)),
  resolveArray: jest.fn((value: unknown, d: unknown[] = []) => (Array.isArray(value) ? value : d)),
}
jest.mock("../a2ui-context", () => ({
  useA2UIContext: jest.fn(() => ({ ...mockDataCtx })),
  useA2UIData: jest.fn(() => mockDataCtx),
  useA2UIActions: jest.fn(() => ({
    surfaceId: "test-surface",
    catalog: undefined,
    emitAction: jest.fn(),
    setDataValue: jest.fn(),
    getBindingPath: jest.fn(),
    getComponent: jest.fn(),
    renderChild: jest.fn(),
  })),
}))

// Mock the data-model
jest.mock("@/lib/a2ui/data-model", () => ({
  getBindingPath: jest.fn((value) =>
    typeof value === "string" && value.startsWith("/") ? value : null
  ),
}))

const createMockComponent = (
  overrides: Partial<A2UITimePickerComponent> = {}
): A2UITimePickerComponent => ({
  id: "test-timepicker",
  component: "TimePicker",
  value: "",
  ...overrides,
})

const defaultProps = {
  surfaceId: "test-surface",
  dataModel: {},
  onDataChange: jest.fn(),
  renderChild: jest.fn(),
}

describe("A2UITimePicker", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("rendering", () => {
    it("should render time input", () => {
      render(
        <A2UITimePicker {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      const input = document.querySelector('input[type="time"]')
      expect(input).toBeInTheDocument()
    })

    it("should render label when provided", () => {
      render(
        <A2UITimePicker
          {...defaultProps}
          component={createMockComponent({ label: "Start Time" })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("Start Time")).toBeInTheDocument()
    })

    it("should show required indicator", () => {
      render(
        <A2UITimePicker
          {...defaultProps}
          component={createMockComponent({ label: "Time", required: true })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("*")).toBeInTheDocument()
    })

    it("should set input type to time", () => {
      render(
        <A2UITimePicker {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      const input = document.querySelector('input[type="time"]')
      expect(input).toHaveAttribute("type", "time")
    })
  })

  describe("value handling", () => {
    it("should display provided value", () => {
      const mockUseA2UIData = jest.requireMock("../a2ui-context").useA2UIData
      mockUseA2UIData.mockReturnValue({
        ...mockDataCtx,
        resolveString: jest.fn(() => "14:30"),
      })

      render(
        <A2UITimePicker
          {...defaultProps}
          component={createMockComponent({ value: "14:30" })}
          onAction={jest.fn()}
        />
      )

      const input = document.querySelector('input[type="time"]')
      expect(input).toHaveValue("14:30")
    })

    it("should call onDataChange when value changes", () => {
      const onDataChange = jest.fn()
      const mockGetBindingPath = jest.requireMock("@/lib/a2ui/data-model").getBindingPath
      mockGetBindingPath.mockReturnValue("/time")

      render(
        <A2UITimePicker
          {...defaultProps}
          onDataChange={onDataChange}
          component={createMockComponent({ value: "/time" })}
          onAction={jest.fn()}
        />
      )

      fireEvent.change(document.querySelector('input[type="time"]')!, {
        target: { value: "15:00" },
      })

      expect(onDataChange).toHaveBeenCalledWith("/time", "15:00")
    })
  })

  describe("styling", () => {
    it("should apply custom className", () => {
      const { container } = render(
        <A2UITimePicker
          {...defaultProps}
          component={createMockComponent({ className: "custom-timepicker" })}
          onAction={jest.fn()}
        />
      )

      expect(container.firstChild).toHaveClass("custom-timepicker")
    })

    it("should apply custom style", () => {
      const { container } = render(
        <A2UITimePicker
          {...defaultProps}
          component={createMockComponent({ style: { width: "200px" } })}
          onAction={jest.fn()}
        />
      )

      expect(container.firstChild).toHaveStyle({ width: "200px" })
    })
  })

  describe("disabled state", () => {
    it("should disable input when disabled is true", () => {
      render(
        <A2UITimePicker
          {...defaultProps}
          component={createMockComponent({ disabled: true })}
          onAction={jest.fn()}
        />
      )

      const input = document.querySelector('input[type="time"]')
      expect(input).toBeDisabled()
    })
  })

  describe("placeholder", () => {
    it("should show placeholder", () => {
      render(
        <A2UITimePicker
          {...defaultProps}
          component={createMockComponent({ placeholder: "Enter time" })}
          onAction={jest.fn()}
        />
      )

      const input = document.querySelector('input[type="time"]')
      expect(input).toHaveAttribute("placeholder", "Enter time")
    })
  })
})
