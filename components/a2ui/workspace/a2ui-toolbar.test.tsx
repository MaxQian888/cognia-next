/**
 * Tests for the workspace toolbar (undo / redo / save / export).
 */

import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import enMessages from "@/i18n/messages/en.json"

const undo = jest.fn()
const redo = jest.fn()
const exportApp = jest.fn()
const downloadApp = jest.fn()
const getAppInstance = jest.fn(() => ({ locale: "zh-CN" as const }))
const replaceSurfaceContent = jest.fn()
const saveApp = jest.fn(async () => true)
const storeState: Record<string, unknown> = {
  undo,
  redo,
  replaceSurfaceContent,
  undoStacks: { sx: [{ id: "s1" }] },
  redoStacks: {},
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: Record<string, unknown>) => unknown) => selector(storeState),
}))

jest.mock("@/hooks/a2ui/use-app-builder", () => ({
  useA2UIAppBuilder: () => ({ exportApp, downloadApp, getAppInstance }),
}))

jest.mock("@/hooks/a2ui/use-a2ui-save", () => ({
  useA2UISave: () => saveApp,
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

const createShareLink = jest.fn()
jest.mock("@/lib/share/client", () => {
  class ShareNotConfiguredError extends Error {}
  return {
    createShareLink: (...a: unknown[]) => createShareLink(...a),
    revokeShareLink: jest.fn(),
    ShareNotConfiguredError,
  }
})

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
    downloadApp.mockReset()
    downloadApp.mockReturnValue(true)
    replaceSurfaceContent.mockReset()
    replaceSurfaceContent.mockReturnValue(true)
    saveApp.mockReset()
    saveApp.mockResolvedValue(true)
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

  it("save persists via useA2UISave and toasts success", async () => {
    renderToolbar()
    const saveButtons = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg.lucide-save"))
    expect(saveButtons.length).toBeGreaterThan(0)
    fireEvent.click(saveButtons[0])
    await waitFor(() => expect(saveApp).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalled()
  })

  it("save toasts an error when the save cannot complete", async () => {
    saveApp.mockResolvedValueOnce(false)
    renderToolbar()
    const saveButtons = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg.lucide-save"))
    fireEvent.click(saveButtons[0])
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })

  it("export downloads the serialized app and toasts success", () => {
    renderToolbar()
    const exportButtons = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg.lucide-download"))
    expect(exportButtons.length).toBeGreaterThan(0)
    fireEvent.click(exportButtons[0])
    expect(downloadApp).toHaveBeenCalledWith("sx")
    expect(toast.success).toHaveBeenCalled()
  })

  it("export shows an error toast when the download cannot be created", () => {
    downloadApp.mockReturnValueOnce(false)
    renderToolbar()
    const exportButtons = screen
      .getAllByRole("button")
      .filter((b) => b.querySelector("svg.lucide-download"))
    fireEvent.click(exportButtons[0])
    expect(toast.error).toHaveBeenCalled()
  })

  it("regenerates the current app from a prompt without changing its surface id", async () => {
    renderToolbar()

    fireEvent.click(screen.getByRole("button", { name: "AI Generate" }))
    fireEvent.change(screen.getByPlaceholderText("Describe what you want to change..."), {
      target: { value: "Turn this into a BMI calculator" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }))

    await waitFor(() => expect(replaceSurfaceContent).toHaveBeenCalled())
    expect(replaceSurfaceContent).toHaveBeenCalledWith(
      "sx",
      expect.arrayContaining([
        expect.objectContaining({ id: "root" }),
        expect.objectContaining({ id: "header", text: "🏃 BMI 计算器" }),
      ]),
      expect.objectContaining({ bmi: 0 }),
      "root"
    )
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(toast.success).toHaveBeenCalled()
  })

  it("share opens the dialog and creates an a2ui link from the exported app", async () => {
    exportApp.mockReturnValue('{"app":{"name":"My App"}}')
    createShareLink.mockResolvedValue({ code: "C", url: "https://share.test/v/C#k=K" })
    renderToolbar()

    const shareButton = screen
      .getAllByRole("button")
      .find((b) => b.querySelector("svg.lucide-share2"))!
    fireEvent.click(shareButton)

    fireEvent.click(await screen.findByRole("button", { name: "Create link" }))
    await screen.findByText("Your share link is ready")
    expect(exportApp).toHaveBeenCalledWith("sx")
    expect(createShareLink).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ kind: "a2ui", title: "My App" }),
      })
    )
  })
})
