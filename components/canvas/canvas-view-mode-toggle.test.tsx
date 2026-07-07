/**
 * @jest-environment jsdom
 *
 * Tests for CanvasViewModeToggle — confirms it reflects and drives the layout
 * store's previewMode, and hides "split" in compact mode.
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CanvasViewModeToggle } from "./canvas-view-mode-toggle"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"

function setMode(mode: "code" | "split" | "preview") {
  act(() => useCanvasLayoutStore.getState().setPreviewMode(mode))
}

describe("CanvasViewModeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear()
    act(() => useCanvasLayoutStore.getState().resetLayout())
  })

  it("renders all three modes and marks the active one pressed", () => {
    setMode("split")
    render(<CanvasViewModeToggle />)
    expect(screen.getByRole("radio", { name: /Show editor and preview/i })).toHaveAttribute(
      "data-state",
      "on"
    )
    expect(screen.getByText("Code")).toBeInTheDocument()
    expect(screen.getByText("Preview")).toBeInTheDocument()
    expect(screen.getByText("Split")).toBeInTheDocument()
  })

  it("switches the store's previewMode when a mode is clicked", async () => {
    const user = userEvent.setup()
    setMode("code")
    render(<CanvasViewModeToggle />)
    await user.click(screen.getByRole("radio", { name: /Show preview only/i }))
    expect(useCanvasLayoutStore.getState().previewMode).toBe("preview")
  })

  it("hides the split option and presents a persisted split as code in compact mode", () => {
    setMode("split")
    render(<CanvasViewModeToggle compact />)
    expect(screen.queryByText("Split")).not.toBeInTheDocument()
    // With split hidden, the control falls back to the code option being active.
    expect(screen.getByRole("radio", { name: /Show editor only/i })).toHaveAttribute(
      "data-state",
      "on"
    )
  })
})
