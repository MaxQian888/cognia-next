import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIWidgetShell } from "./a2ui-widget-shell"

describe("A2UIWidgetShell", () => {
  it("applies dark theme and a fixed-height scrolling viewport", () => {
    render(
      <A2UIWidgetShell theme="dark" sizing="fixed-height" minHeight={240}>
        <div>Widget body</div>
      </A2UIWidgetShell>
    )

    const shell = screen.getByTestId("a2ui-widget-shell")
    expect(shell).toHaveAttribute("data-theme", "dark")
    expect(shell).toHaveAttribute("data-sizing", "fixed-height")
    expect(shell).toHaveClass("a2ui-widget-theme-dark", "overflow-auto")
    expect(shell).toHaveStyle({ height: "240px", minHeight: "240px" })
  })

  it("uses the fixed-height default when minHeight is omitted", () => {
    render(
      <A2UIWidgetShell sizing="fixed-height">
        <div>Widget body</div>
      </A2UIWidgetShell>
    )

    expect(screen.getByTestId("a2ui-widget-shell")).toHaveStyle({ height: "320px" })
  })

  it("applies a light content-height scope without forcing a height", () => {
    render(
      <A2UIWidgetShell theme="light" sizing="content-height" minHeight={120}>
        <div>Widget body</div>
      </A2UIWidgetShell>
    )

    const shell = screen.getByTestId("a2ui-widget-shell")
    expect(shell).toHaveClass("a2ui-widget-theme-light")
    expect(shell).toHaveStyle({ minHeight: "120px" })
    expect(shell.style.height).toBe("")
  })

  it("renders fallback content instead of children for error states", () => {
    render(
      <A2UIWidgetShell status="error" fallbackText="Unavailable">
        <div>Widget body</div>
      </A2UIWidgetShell>
    )

    expect(screen.getByText("Unavailable")).toBeInTheDocument()
    expect(screen.queryByText("Widget body")).not.toBeInTheDocument()
  })
})
