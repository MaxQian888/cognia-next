/**
 * A2UI DateTimePicker Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UIDateTimePicker } from "./a2ui-datetimepicker"
import type { A2UIDateTimePickerComponent } from "@/types/a2ui/schema"

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
  overrides: Partial<A2UIDateTimePickerComponent> = {}
): A2UIDateTimePickerComponent => ({
  id: "test-datetimepicker",
  component: "DateTimePicker",
  value: "",
  ...overrides,
})

const defaultProps = {
  surfaceId: "test-surface",
  dataModel: {},
  onDataChange: jest.fn(),
  renderChild: jest.fn(),
}

describe("A2UIDateTimePicker", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("rendering", () => {
    it("should render datetime input", () => {
      render(
        <A2UIDateTimePicker
          {...defaultProps}
          component={createMockComponent()}
          onAction={jest.fn()}
        />
      )

      const input = document.querySelector('input[type="datetime-local"]')
      expect(input).toBeInTheDocument()
    })

    it("should render label when provided", () => {
      render(
        <A2UIDateTimePicker
          {...defaultProps}
          component={createMockComponent({ label: "Event Time" })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("Event Time")).toBeInTheDocument()
    })

    it("should show required indicator", () => {
      render(
        <A2UIDateTimePicker
          {...defaultProps}
          component={createMockComponent({ label: "DateTime", required: true })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("*")).toBeInTheDocument()
    })

    it("should set input type to datetime-local", () => {
      render(
        <A2UIDateTimePicker
          {...defaultProps}
          component={createMockComponent()}
          onAction={jest.fn()}
        />
      )

      const input = document.querySelector('input[type="datetime-local"]')
      expect(input).toHaveAttribute("type", "datetime-local")
    })
  })

  describe("value handling", () => {
    it("should format ISO value for datetime-local input", () => {
      const mockUseA2UIData = jest.requireMock("../a2ui-context").useA2UIData
      mockUseA2UIData.mockReturnValue({
        ...mockDataCtx,
        resolveString: jest.fn(() => "2024-01-15T14:30:00.000Z"),
      })

      render(
        <A2UIDateTimePicker
          {...defaultProps}
          component={createMockComponent({ value: "2024-01-15T14:30:00.000Z" })}
          onAction={jest.fn()}
        />
      )

      const input = document.querySelector('input[type="datetime-local"]')
      expect(input).toHaveValue("2024-01-15T14:30")
    })

    it("should call onDataChange when value changes", () => {
      const onDataChange = jest.fn()
      const mockGetBindingPath = jest.requireMock("@/lib/a2ui/data-model").getBindingPath
      mockGetBindingPath.mockReturnValue("/datetime")

      render(
        <A2UIDateTimePicker
          {...defaultProps}
          onDataChange={onDataChange}
          component={createMockComponent({ value: "/datetime" })}
          onAction={jest.fn()}
        />
      )

      fireEvent.change(document.querySelector('input[type="datetime-local"]')!, {
        target: { value: "2024-01-20T10:00" },
      })

      expect(onDataChange).toHaveBeenCalled()
    })
  })

  describe("styling", () => {
    it("should apply custom className", () => {
      const { container } = render(
        <A2UIDateTimePicker
          {...defaultProps}
          component={createMockComponent({ className: "custom-datetime" })}
          onAction={jest.fn()}
        />
      )

      expect(container.firstChild).toHaveClass("custom-datetime")
    })

    it("should apply custom style", () => {
      const { container } = render(
        <A2UIDateTimePicker
          {...defaultProps}
          component={createMockComponent({ style: { width: "400px" } })}
          onAction={jest.fn()}
        />
      )

      expect(container.firstChild).toHaveStyle({ width: "400px" })
    })
  })

  describe("disabled state", () => {
    it("should disable input when disabled is true", () => {
      render(
        <A2UIDateTimePicker
          {...defaultProps}
          component={createMockComponent({ disabled: true })}
          onAction={jest.fn()}
        />
      )

      const input = document.querySelector('input[type="datetime-local"]')
      expect(input).toBeDisabled()
    })
  })

  describe("min/max constraints", () => {
    it("should set min attribute", () => {
      render(
        <A2UIDateTimePicker
          {...defaultProps}
          component={createMockComponent({ minDate: "2024-01-01T00:00:00.000Z" })}
          onAction={jest.fn()}
        />
      )

      const input = document.querySelector('input[type="datetime-local"]')
      expect(input).toHaveAttribute("min", "2024-01-01T00:00")
    })

    it("should set max attribute", () => {
      render(
        <A2UIDateTimePicker
          {...defaultProps}
          component={createMockComponent({ maxDate: "2024-12-31T23:59:00.000Z" })}
          onAction={jest.fn()}
        />
      )

      const input = document.querySelector('input[type="datetime-local"]')
      expect(input).toHaveAttribute("max", "2024-12-31T23:59")
    })
  })
})
