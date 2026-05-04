/**
 * A2UI Error Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { A2UIError, type A2UIErrorComponent } from "./a2ui-error"

const createMockComponent = (overrides: Partial<A2UIErrorComponent> = {}): A2UIErrorComponent => ({
  id: "test-error",
  component: "Error",
  message: "An error occurred",
  ...overrides,
})

const defaultProps = {
  surfaceId: "test-surface",
  dataModel: {},
  onDataChange: jest.fn(),
  renderChild: jest.fn(),
}

describe("A2UIError", () => {
  describe("rendering", () => {
    it("should render error message", () => {
      render(
        <A2UIError
          {...defaultProps}
          component={createMockComponent({ message: "Test error message" })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("Test error message")).toBeInTheDocument()
    })

    it('should render with role="alert"', () => {
      render(<A2UIError {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />)

      expect(screen.getByRole("alert")).toBeInTheDocument()
    })

    it("should render title when provided", () => {
      render(
        <A2UIError
          {...defaultProps}
          component={createMockComponent({ title: "Error Title" })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByText("Error Title")).toBeInTheDocument()
    })

    it("should not render title when not provided", () => {
      render(
        <A2UIError
          {...defaultProps}
          component={createMockComponent({ title: undefined })}
          onAction={jest.fn()}
        />
      )

      // Should only show message
      expect(screen.getByText("An error occurred")).toBeInTheDocument()
    })

    it("should reveal stack trace details when message contains trace lines", async () => {
      const user = userEvent.setup()

      render(
        <A2UIError
          {...defaultProps}
          component={createMockComponent({
            message: "Error: Widget failed\n    at WidgetNode (components/a2ui/widget.tsx:8:4)",
          })}
          onAction={jest.fn()}
        />
      )

      // The cognia-next ErrorTraceDetails hides the stack behind a "Show stack
      // trace" button (Radix Collapsible). The headline ("Widget failed") is
      // peeled off the first line of the message; the stack frames are
      // collapsed by default and revealed by clicking the toggle.
      expect(screen.queryByText(/components\/a2ui\/widget\.tsx/)).not.toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: /show stack trace/i }))
      expect(screen.getByText(/components\/a2ui\/widget\.tsx/)).toBeInTheDocument()
    })
  })

  describe("variants", () => {
    it("should render inline variant by default", () => {
      const { container } = render(
        <A2UIError {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />
      )

      expect(container.firstChild).toHaveClass("flex", "items-start")
    })

    it("should render card variant", () => {
      const { container } = render(
        <A2UIError
          {...defaultProps}
          component={createMockComponent({ variant: "card" })}
          onAction={jest.fn()}
        />
      )

      expect(container.firstChild).toHaveClass("rounded-lg", "border")
    })

    it("should render fullpage variant", () => {
      const { container } = render(
        <A2UIError
          {...defaultProps}
          component={createMockComponent({ variant: "fullpage" })}
          onAction={jest.fn()}
        />
      )

      expect(container.firstChild).toHaveClass("min-h-[200px]", "justify-center")
    })
  })

  describe("retry functionality", () => {
    it("should render retry button when retryAction is provided", () => {
      render(
        <A2UIError
          {...defaultProps}
          component={createMockComponent({ retryAction: "retry" })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument()
    })

    it("should not render retry button when retryAction is not provided", () => {
      render(<A2UIError {...defaultProps} component={createMockComponent()} onAction={jest.fn()} />)

      expect(screen.queryByRole("button")).not.toBeInTheDocument()
    })

    it("should call onAction when retry button is clicked", () => {
      const onAction = jest.fn()
      render(
        <A2UIError
          {...defaultProps}
          component={createMockComponent({ retryAction: "retry_action" })}
          onAction={onAction}
        />
      )

      fireEvent.click(screen.getByRole("button", { name: /retry/i }))

      expect(onAction).toHaveBeenCalledWith("retry_action", {})
    })

    it("should use custom retry label", () => {
      render(
        <A2UIError
          {...defaultProps}
          component={createMockComponent({
            retryAction: "retry",
            retryLabel: "Try Again",
          })}
          onAction={jest.fn()}
        />
      )

      expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument()
    })
  })

  describe("styling", () => {
    it("should apply custom className", () => {
      const { container } = render(
        <A2UIError
          {...defaultProps}
          component={createMockComponent({ className: "custom-error-class" })}
          onAction={jest.fn()}
        />
      )

      expect(container.firstChild).toHaveClass("custom-error-class")
    })

    it("should apply custom style", () => {
      const { container } = render(
        <A2UIError
          {...defaultProps}
          component={createMockComponent({ style: { backgroundColor: "red" } })}
          onAction={jest.fn()}
        />
      )

      expect(container.firstChild).toHaveStyle({ backgroundColor: "rgb(255, 0, 0)" })
    })
  })
})
