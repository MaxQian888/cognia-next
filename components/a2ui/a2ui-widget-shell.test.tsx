import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIWidgetShell } from "./a2ui-widget-shell"

describe("A2UIWidgetShell", () => {
  it("renders shared widget chrome with title and host badge", () => {
    render(
      <A2UIWidgetShell title="Widget Title" hostStrategy="sandboxed-html">
        <div>Widget body</div>
      </A2UIWidgetShell>
    )

    expect(screen.getByTestId("a2ui-widget-shell")).toBeInTheDocument()
    expect(screen.getByText("Widget Title")).toBeInTheDocument()
    expect(screen.getByText("sandboxed-html")).toBeInTheDocument()
    expect(screen.getByText("Widget body")).toBeInTheDocument()
  })

  it("renders fallback copy when status is fallback", () => {
    render(
      <A2UIWidgetShell status="fallback" fallbackText="Using fallback presentation.">
        <div>Hidden body</div>
      </A2UIWidgetShell>
    )

    expect(screen.getByText("Using fallback presentation.")).toBeInTheDocument()
    expect(screen.queryByText("Hidden body")).not.toBeInTheDocument()
  })
})
