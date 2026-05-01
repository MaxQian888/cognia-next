/**
 * A2UI Fallback Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIFallback } from "./a2ui-fallback"
import type { A2UIBaseComponent } from "@/types/a2ui/schema"

const createMockComponent = (overrides: Partial<A2UIBaseComponent> = {}): A2UIBaseComponent => ({
  id: "test-fallback",
  component: "UnknownComponent",
  ...overrides,
})

const defaultProps = {
  surfaceId: "test-surface",
  dataModel: {},
  onDataChange: jest.fn(),
  renderChild: jest.fn(),
}

describe("A2UIFallback", () => {
  describe("rendering", () => {
    it("should render fallback message", () => {
      render(
        <A2UIFallback {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      expect(screen.getByText(/unknown component/i)).toBeInTheDocument()
    })

    it("should display the unknown component type", () => {
      render(
        <A2UIFallback
          {...defaultProps}
          component={createMockComponent({ component: "MyCustomComponent" })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("MyCustomComponent")).toBeInTheDocument()
    })

    it("should render with warning icon", () => {
      const { container } = render(
        <A2UIFallback {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      const icon = container.querySelector("svg")
      expect(icon).toBeInTheDocument()
    })
  })

  describe("styling", () => {
    it("should apply custom className", () => {
      const { container } = render(
        <A2UIFallback
          {...defaultProps}
          component={createMockComponent({ className: "custom-fallback-class" })}
          onAction={jest.fn()}
        />
      )

      expect(container.firstChild).toHaveClass("custom-fallback-class")
    })

    it("should apply custom style", () => {
      const { container } = render(
        <A2UIFallback
          {...defaultProps}
          component={createMockComponent({ style: { padding: "20px" } })}
          onAction={jest.fn()}
        />
      )

      expect(container.firstChild).toHaveStyle({ padding: "20px" })
    })

    it("should have warning border styling", () => {
      const { container } = render(
        <A2UIFallback {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      expect(container.firstChild).toHaveClass("border-dashed", "border-amber-300")
    })
  })

  describe("different component types", () => {
    const componentTypes = ["Button", "CustomWidget", "UnregisteredForm", "SpecialComponent123"]

    componentTypes.forEach((type) => {
      it(`should display "${type}" when component type is ${type}`, () => {
        render(
          <A2UIFallback
            {...defaultProps}
            component={createMockComponent({ component: type })}
            onAction={jest.fn()}
          />
        )

        expect(screen.getByText(type)).toBeInTheDocument()
      })
    })
  })
})
