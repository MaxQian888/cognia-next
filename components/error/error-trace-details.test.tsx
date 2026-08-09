/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { ErrorTraceDetails } from "./error-trace-details"

describe("ErrorTraceDetails", () => {
  it("renders nothing when error is null", () => {
    const { container } = render(<ErrorTraceDetails error={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the error and official stack trace actions", () => {
    render(
      <ErrorTraceDetails
        error={{
          message: "Widget failed",
          stack: "TypeError: Widget failed\n at run (/app/a.ts:2:3)",
        }}
      />
    )

    expect(screen.getAllByText("Widget failed")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Copy stack trace" })).toBeInTheDocument()
  })

  it("keeps the plugin disable action", () => {
    const onDisablePlugin = jest.fn()
    render(
      <ErrorTraceDetails
        error={new Error("oops")}
        pluginId="cognia-x"
        pluginName="Cognia X"
        title="Plugin error"
        onDisablePlugin={onDisablePlugin}
      />
    )

    expect(screen.getByText("Plugin error — Cognia X")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Disable plugin" }))
    expect(onDisablePlugin).toHaveBeenCalledWith("cognia-x")
  })

  it("renders a rich body instead of duplicating the plain message", () => {
    render(
      <ErrorTraceDetails
        error={{ message: "raw message" }}
        body={<div data-testid="rich-body">structured</div>}
      />
    )
    expect(screen.getByTestId("rich-body")).toHaveTextContent("structured")
    expect(screen.queryByText("raw message")).not.toBeInTheDocument()
  })
})
