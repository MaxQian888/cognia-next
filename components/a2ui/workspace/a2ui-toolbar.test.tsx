/**
 * Tests for the workspace toolbar (undo / redo / save / export).
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import enMessages from "@/i18n/messages/en.json"

const undo = jest.fn()
const redo = jest.fn()
const exportApp = jest.fn()
const storeState: Record<string, unknown> = {
  undo,
  redo,
  undoStacks: { sx: [{ id: "s1" }] },
  redoStacks: {},
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: Record<string, unknown>) => unknown) => selector(storeState),
}))

jest.mock("@/hooks/a2ui/use-app-builder", () => ({
  useA2UIAppBuilder: () => ({ exportApp }),
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { A2UIToolbar } from "./a2ui-toolbar"
import { toast } from "sonner"

function renderToolbar(surfaceId = "sx") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <TooltipProvider>
        <A2UIWorkspaceProvider surfaceId={surfaceId}>
          <A2UIToolbar />
        </A2UIWorkspaceProvider>
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

describe("A2UIToolbar", () => {
  beforeEach(() => {
    undo.mockReset()
    redo.mockReset()
    exportApp.mockReset()
    ;(toast.success as jest.Mock).mockReset()
    ;(toast.error as jest.Mock).mockReset()
    storeState.undoStacks = { sx: [{ id: "s1" }] }
    storeState.redoStacks = {}
  })

  it("renders without crashing and shows the action buttons (smoke)", () => {
    const { container } = renderToolbar()
    expect(container.querySelectorAll("button").length).toBeGreaterThanOrEqual(6)
  })

  it("disables redo when redoStacks is empty for the active surface", () => {
    renderToolbar()
    const buttons = screen.getAllByRole("button")
    // First button is Undo, second is Redo (per render order in source)
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true)
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false)
  })

  it("disables undo when undoStacks is empty", () => {
    storeState.undoStacks = {}
    renderToolbar()
    const buttons = screen.getAllByRole("button")
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true)
  })

  it("calls undo / redo with the surfaceId when their buttons are clicked", () => {
    storeState.undoStacks = { sx: [{ id: "s1" }] }
    storeState.redoStacks = { sx: [{ id: "r1" }] }
    renderToolbar()
    const buttons = screen.getAllByRole("button")
    fireEvent.click(buttons[0])
    expect(undo).toHaveBeenCalledWith("sx")
    fireEvent.click(buttons[1])
    expect(redo).toHaveBeenCalledWith("sx")
  })

  it("save fires a toast success", () => {
    renderToolbar()
    // The save button has the saveApp aria label. Use title attribute via tooltip text.
    const saveButtons = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg.lucide-save"))
    expect(saveButtons.length).toBeGreaterThan(0)
    fireEvent.click(saveButtons[0])
    expect(toast.success).toHaveBeenCalled()
  })

  it("export calls appBuilder.exportApp + success toast", () => {
    renderToolbar()
    const exportButtons = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg.lucide-download"))
    expect(exportButtons.length).toBeGreaterThan(0)
    fireEvent.click(exportButtons[0])
    expect(exportApp).toHaveBeenCalledWith("sx")
    expect(toast.success).toHaveBeenCalled()
  })

  it("export shows an error toast when exportApp throws", () => {
    exportApp.mockImplementation(() => {
      throw new Error("nope")
    })
    renderToolbar()
    const exportButtons = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg.lucide-download"))
    fireEvent.click(exportButtons[0])
    expect(toast.error).toHaveBeenCalled()
  })
})
