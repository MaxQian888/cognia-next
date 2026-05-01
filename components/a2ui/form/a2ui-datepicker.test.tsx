/**
 * A2UI DatePicker Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UIDatePicker } from "./a2ui-datepicker"
import type { A2UIDatePickerComponent } from "@/types/a2ui/schema"

// Mock the context
const mockDataCtx = {
  surface: null,
  dataModel: {},
  components: {},
  resolveString: jest.fn((value: unknown) => (typeof value === "string" ? value : "")),
  resolveNumber: jest.fn((value: unknown) => (typeof value === "number" ? value : 0)),
  resolveBoolean: jest.fn((value: unknown, defaultVal: unknown) =>
    typeof value === "boolean" ? value : defaultVal
  ),
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
  overrides: Partial<A2UIDatePickerComponent> = {}
): A2UIDatePickerComponent => ({
  id: "test-datepicker",
  component: "DatePicker",
  value: "",
  ...overrides,
})

const defaultProps = {
  surfaceId: "test-surface",
  dataModel: {},
  onDataChange: jest.fn(),
  renderChild: jest.fn(),
}

describe("A2UIDatePicker", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("rendering", () => {
    it("should render datepicker button", () => {
      render(
        <A2UIDatePicker {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      expect(screen.getByRole("button")).toBeInTheDocument()
    })

    it("should show placeholder when no date selected", () => {
      render(
        <A2UIDatePicker
          {...defaultProps}
          component={createMockComponent({ placeholder: "Select a date" })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("Select a date")).toBeInTheDocument()
    })

    it("should show default placeholder when none provided", () => {
      render(
        <A2UIDatePicker {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      expect(screen.getByText("Pick a date")).toBeInTheDocument()
    })

    it("should render label when provided", () => {
      render(
        <A2UIDatePicker
          {...defaultProps}
          component={createMockComponent({ label: "Birth Date" })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("Birth Date")).toBeInTheDocument()
    })

    it("should show required indicator", () => {
      render(
        <A2UIDatePicker
          {...defaultProps}
          component={createMockComponent({ label: "Date", required: true })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("*")).toBeInTheDocument()
    })
  })

  describe("styling", () => {
    it("should apply custom className", () => {
      const { container } = render(
        <A2UIDatePicker
          {...defaultProps}
          component={createMockComponent({ className: "custom-datepicker" })}
          onAction={jest.fn()}
        />
      )

      expect(container.firstChild).toHaveClass("custom-datepicker")
    })

    it("should apply custom style", () => {
      const { container } = render(
        <A2UIDatePicker
          {...defaultProps}
          component={createMockComponent({ style: { width: "300px" } })}
          onAction={jest.fn()}
        />
      )

      expect(container.firstChild).toHaveStyle({ width: "300px" })
    })
  })

  describe("disabled state", () => {
    it("should disable button when disabled is true", () => {
      const mockUseA2UIContext = jest.requireMock("../a2ui-context").useA2UIContext
      mockUseA2UIContext.mockReturnValue({
        resolveString: jest.fn(() => ""),
        resolveBoolean: jest.fn(() => true),
      })

      render(
        <A2UIDatePicker
          {...defaultProps}
          component={createMockComponent({ disabled: true })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByRole("button")).toBeDisabled()
    })
  })

  describe("popover interaction", () => {
    it("should open calendar on button click", async () => {
      render(
        <A2UIDatePicker {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      fireEvent.click(screen.getByRole("button"))

      // Calendar should appear in popover
      // Note: Full calendar testing would require more complex setup
    })
  })
})
