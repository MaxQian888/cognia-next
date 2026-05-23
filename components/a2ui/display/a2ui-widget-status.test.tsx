/**
 * Tests for A2UIWidgetStatus — the status-banner widget surfaced for widget
 * shells in `loading` / `fallback` / `error` states.
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { A2UIWidgetStatus } from "./a2ui-widget-status"
import type { A2UIComponentProps, A2UIWidgetStatusComponent } from "@/types/a2ui/schema"

function createProps(
  component: Partial<A2UIWidgetStatusComponent> & {
    id?: string
    status: A2UIWidgetStatusComponent["status"]
    message: string
  }
): A2UIComponentProps<A2UIWidgetStatusComponent> {
  const merged: A2UIWidgetStatusComponent = {
    id: component.id ?? "status-1",
    component: "WidgetStatus",
    status: component.status,
    message: component.message,
    title: component.title,
    detail: component.detail,
    action: component.action,
    actionLabel: component.actionLabel,
  }
  return {
    component: merged,
    surfaceId: "surface-1",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(() => null),
  }
}

describe("A2UIWidgetStatus", () => {
  it("renders title, message and the status badge", () => {
    const props = createProps({
      status: "ready",
      title: "Surface ready",
      message: "Everything looks good.",
    })
    render(<A2UIWidgetStatus {...props} />)
    expect(screen.getByText("Surface ready")).toBeInTheDocument()
    expect(screen.getByText("Everything looks good.")).toBeInTheDocument()
    expect(screen.getByText("ready")).toBeInTheDocument()
  })

  it("renders the optional detail line when provided", () => {
    const props = createProps({
      status: "fallback",
      message: "Native renderer unavailable.",
      detail: "Falling back to artifact preview.",
    })
    render(<A2UIWidgetStatus {...props} />)
    expect(screen.getByText("Falling back to artifact preview.")).toBeInTheDocument()
  })

  it("renders an action button when both `action` and `actionLabel` are set and fires onAction", () => {
    const props = createProps({
      status: "error",
      message: "Boom.",
      action: "retry",
      actionLabel: "Retry",
    })
    render(<A2UIWidgetStatus {...props} />)
    const btn = screen.getByRole("button", { name: "Retry" })
    fireEvent.click(btn)
    expect(props.onAction).toHaveBeenCalledWith("retry")
  })

  it("omits the action button when `actionLabel` is missing", () => {
    const props = createProps({ status: "loading", message: "Loading…", action: "cancel" })
    render(<A2UIWidgetStatus {...props} />)
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("renders the spinner-style icon class for loading status", () => {
    const props = createProps({ status: "loading", message: "Loading…" })
    const { container } = render(<A2UIWidgetStatus {...props} />)
    expect(container.querySelector(".animate-spin")).not.toBeNull()
  })
})
