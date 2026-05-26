/**
 * A2UI Form Group Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIFormGroup, type A2UIFormGroupComponent } from "./a2ui-form-group"

// Mock useA2UIForm hook
const mockFormState = {
  values: {},
  errors: {},
  touched: {},
  isValid: true,
  isDirty: false,
  isSubmitting: false,
  handleChange: jest.fn(),
  handleBlur: jest.fn(),
  handleSubmit: jest.fn(),
  reset: jest.fn(),
  setFieldValue: jest.fn(),
  setFieldError: jest.fn(),
  validate: jest.fn(() => true),
}
jest.mock("@/hooks/a2ui/use-a2ui-form", () => ({
  useA2UIForm: () => mockFormState,
}))

// Mock the child renderer
jest.mock("../a2ui-child-renderer", () => ({
  A2UIChildRenderer: ({ childIds }: { childIds: string[] }) => (
    <div data-testid="child-renderer">{childIds.join(", ")}</div>
  ),
}))

const createMockComponent = (
  overrides: Partial<A2UIFormGroupComponent> = {}
): A2UIFormGroupComponent => ({
  id: "test-form-group",
  component: "FormGroup",
  children: ["field-1", "field-2"],
  ...overrides,
})

const defaultProps = {
  surfaceId: "test-surface",
  dataModel: {},
  onDataChange: jest.fn(),
  renderChild: jest.fn(),
}

describe("A2UIFormGroup", () => {
  describe("rendering", () => {
    it("should render form group with children", () => {
      render(
        <A2UIFormGroup {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      expect(screen.getByTestId("child-renderer")).toBeInTheDocument()
    })

    it("should render as fieldset element", () => {
      const { container } = render(
        <A2UIFormGroup {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      expect(container.querySelector("fieldset")).toBeInTheDocument()
    })

    it("should render legend when provided", () => {
      render(
        <A2UIFormGroup
          {...defaultProps}
          component={createMockComponent({ legend: "Form Legend" })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("Form Legend")).toBeInTheDocument()
    })

    it("should render description when provided", () => {
      render(
        <A2UIFormGroup
          {...defaultProps}
          component={createMockComponent({ description: "Form description text" })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("Form description text")).toBeInTheDocument()
    })

    it("should show required indicator when required is true", () => {
      render(
        <A2UIFormGroup
          {...defaultProps}
          component={createMockComponent({ legend: "Required Field", required: true })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("*")).toBeInTheDocument()
    })

    it("should not show required indicator when required is false", () => {
      render(
        <A2UIFormGroup
          {...defaultProps}
          component={createMockComponent({ legend: "Optional Field", required: false })}
          onAction={jest.fn()}
        />
      )

      expect(screen.queryByText("*")).not.toBeInTheDocument()
    })
  })

  describe("layout", () => {
    it("should use vertical layout by default", () => {
      const { container } = render(
        <A2UIFormGroup {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      const layoutDiv = container.querySelector("fieldset > div")
      expect(layoutDiv).toHaveClass("flex", "flex-col")
    })

    it("should apply horizontal layout", () => {
      const { container } = render(
        <A2UIFormGroup
          {...defaultProps}
          component={createMockComponent({ layout: "horizontal" })}
          onAction={jest.fn()}
        />
      )

      const layoutDiv = container.querySelector("fieldset > div")
      expect(layoutDiv).toHaveClass("flex", "flex-row")
    })

    it("should apply grid layout", () => {
      const { container } = render(
        <A2UIFormGroup
          {...defaultProps}
          component={createMockComponent({ layout: "grid", columns: 3 })}
          onAction={jest.fn()}
        />
      )

      const layoutDiv = container.querySelector("fieldset > div")
      expect(layoutDiv).toHaveClass("grid")
    })
  })

  describe("styling", () => {
    it("should apply custom className", () => {
      const { container } = render(
        <A2UIFormGroup
          {...defaultProps}
          component={createMockComponent({ className: "custom-form-class" })}
          onAction={jest.fn()}
        />
      )

      expect(container.querySelector("fieldset")).toHaveClass("custom-form-class")
    })

    it("should apply custom style", () => {
      const { container } = render(
        <A2UIFormGroup
          {...defaultProps}
          component={createMockComponent({ style: { marginTop: "20px" } })}
          onAction={jest.fn()}
        />
      )

      expect(container.querySelector("fieldset")).toHaveStyle({ marginTop: "20px" })
    })

    it("should apply numeric gap class", () => {
      const { container } = render(
        <A2UIFormGroup
          {...defaultProps}
          component={createMockComponent({ gap: 6 })}
          onAction={jest.fn()}
        />
      )

      const layoutDiv = container.querySelector("fieldset > div")
      expect(layoutDiv).toHaveClass("gap-6")
    })

    it("should apply string gap as style", () => {
      const { container } = render(
        <A2UIFormGroup
          {...defaultProps}
          component={createMockComponent({ gap: "2rem" })}
          onAction={jest.fn()}
        />
      )

      const layoutDiv = container.querySelector("fieldset > div")
      expect(layoutDiv).toHaveStyle({ gap: "2rem" })
    })
  })

  describe("children", () => {
    it("should pass children to A2UIChildRenderer", () => {
      render(
        <A2UIFormGroup
          {...defaultProps}
          component={createMockComponent({ children: ["input-1", "input-2", "input-3"] })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("input-1, input-2, input-3")).toBeInTheDocument()
    })
  })

  describe("form validation integration", () => {
    it("should not set aria-invalid when form is valid", () => {
      mockFormState.isValid = true
      mockFormState.isDirty = false

      const { container } = render(
        <A2UIFormGroup {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      const fieldset = container.querySelector("fieldset")
      expect(fieldset).not.toHaveAttribute("aria-invalid", "true")
    })

    it("should set aria-invalid when form is invalid and dirty", () => {
      mockFormState.isValid = false
      mockFormState.isDirty = true

      const { container } = render(
        <A2UIFormGroup {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      const fieldset = container.querySelector("fieldset")
      expect(fieldset).toHaveAttribute("aria-invalid", "true")
    })

    it("should not set aria-invalid when form is invalid but not dirty", () => {
      mockFormState.isValid = false
      mockFormState.isDirty = false

      const { container } = render(
        <A2UIFormGroup {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      const fieldset = container.querySelector("fieldset")
      expect(fieldset).not.toHaveAttribute("aria-invalid", "true")
    })
  })
})
