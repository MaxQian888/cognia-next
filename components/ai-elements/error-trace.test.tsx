/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

import { ErrorTraceDetails } from "./error-trace"

describe("ErrorTraceDetails", () => {
  it("renders nothing when error is null", () => {
    const { container } = render(<ErrorTraceDetails error={null} />)
    expect(container.textContent ?? "").toBe("")
  })

  it("renders the error message headline", () => {
    render(<ErrorTraceDetails error={new Error("Widget failed")} />)
    expect(screen.getByText("Widget failed")).toBeInTheDocument()
  })

  it("appends the plugin name to the title when pluginId is set", () => {
    render(
      <ErrorTraceDetails
        error={new Error("oops")}
        pluginId="cognia-x"
        pluginName="Cognia X"
        title="Plugin error"
      />
    )
    expect(screen.getByText(/Plugin error — Cognia X/)).toBeInTheDocument()
  })

  it("renders the Disable plugin button when onDisablePlugin is provided", () => {
    const onDisable = jest.fn()
    render(
      <ErrorTraceDetails
        error={new Error("oops")}
        pluginId="cognia-x"
        onDisablePlugin={onDisable}
      />
    )
    fireEvent.click(screen.getByText("Disable plugin"))
    expect(onDisable).toHaveBeenCalledWith("cognia-x")
  })

  it("falls back to pluginId when pluginName is missing", () => {
    render(<ErrorTraceDetails error={new Error("oops")} pluginId="cognia-x" title="Plugin error" />)
    expect(screen.getByText(/Plugin error — cognia-x/)).toBeInTheDocument()
  })

  it("renders the body slot in place of the plain message when provided", () => {
    render(
      <ErrorTraceDetails
        error={{ message: "raw message" }}
        body={<div data-testid="rich-body">structured</div>}
      />
    )
    expect(screen.getByTestId("rich-body")).toBeInTheDocument()
    // The plain message paragraph is replaced by the body.
    expect(screen.queryByText("raw message")).not.toBeInTheDocument()
  })
})
