/**
 * Tests for the workspace toolbar (undo / redo / save / export / AI / share).
 */

import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import enMessages from "@/i18n/messages/en.json"
import type { A2UIDispatchMessage, A2UIUpdateDataModelMessage } from "@/types/a2ui/schema"

const undo = jest.fn()
const redo = jest.fn()
const exportApp = jest.fn()
const downloadApp = jest.fn()
const getAppInstance = jest.fn(() => ({ locale: "zh-CN" as const }))
const replaceSurfaceContent = jest.fn()
const updateComponents = jest.fn()
const updateDataModel = jest.fn()
const saveApp = jest.fn(async () => true)
const saveAsTemplate = jest.fn(async () => true)
const storeState: Record<string, unknown> = {
  undo,
  redo,
  replaceSurfaceContent,
  updateComponents,
  updateDataModel,
  surfaces: { sx: { components: { root: { id: "root" }, header: { id: "header" } } } },
  undoStacks: { sx: [{ id: "s1" }] },
  redoStacks: {},
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeState),
    { getState: () => storeState }
  ),
}))

jest.mock("@/lib/db/a2ui-surfaces", () => ({
  listSurfaces: jest.fn(async () => []),
  upsertSurface: jest.fn(async () => {}),
  deleteSurface: jest.fn(async () => {}),
}))

jest.mock("@/stores/settings", () => {
  const state = { settings: { a2uiPersistenceLimit: 20 } }
  return {
    useSettingsStore: Object.assign(
      (selector: (value: typeof state) => unknown) => selector(state),
      { getState: () => state }
    ),
  }
})

const generateA2UIApp = jest.fn()
jest.mock("@/lib/a2ui/ai-generate", () => ({
  generateA2UIApp: (...a: unknown[]) => generateA2UIApp(...a),
  streamDispatchToStore: jest.fn(),
  A2UIAiUnavailableError: class A2UIAiUnavailableError extends Error {
    reason: string
    constructor(reason: string) {
      super(reason)
      this.name = "A2UIAiUnavailableError"
      this.reason = reason
    }
  },
}))

jest.mock("@/hooks/a2ui/use-app-builder", () => ({
  useA2UIAppBuilder: () => ({ exportApp, downloadApp, getAppInstance, saveAsTemplate }),
}))

jest.mock("@/hooks/a2ui/use-a2ui-save", () => ({
  useA2UISave: () => saveApp,
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
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
import { A2UIAiUnavailableError, streamDispatchToStore } from "@/lib/a2ui/ai-generate"
import { toast } from "sonner"

const AI_RESULT = {
  surfaceId: "sx",
  components: [{ id: "root" }, { id: "c1" }],
  dataModel: { count: 1 },
  rootId: "root",
  title: "My App",
  usedFallback: false,
}

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
    updateComponents.mockReset()
    updateDataModel.mockReset()
    ;(streamDispatchToStore as jest.Mock).mockReset()
    generateA2UIApp.mockReset()
    generateA2UIApp.mockResolvedValue(AI_RESULT)
    saveApp.mockReset()
    saveApp.mockResolvedValue(true)
    saveAsTemplate.mockReset()
    saveAsTemplate.mockResolvedValue(true)
    ;(toast.success as jest.Mock).mockReset()
    ;(toast.error as jest.Mock).mockReset()
    ;(toast.info as jest.Mock).mockReset()
    storeState.undoStacks = { sx: [{ id: "s1" }] }
    storeState.redoStacks = {}
    storeState.surfaces = {
      sx: { components: { root: { id: "root" }, header: { id: "header" } } },
    }
  })

  it("renders without crashing and shows the action buttons (smoke)", () => {
    const { container } = renderToolbar()
    expect(container.querySelectorAll("button").length).toBeGreaterThanOrEqual(6)
  })

  it("no longer duplicates the header's edit/preview/data switch", () => {
    renderToolbar()
    const a2ui = (enMessages as unknown as { a2ui: Record<string, string> }).a2ui
    // The mode control lives once, in `WorkspaceHeader`'s tabs. Two differently
    // styled controls for one piece of state was the workspace's worst
    // hierarchy bug.
    expect(screen.queryByRole("button", { name: a2ui.editMode })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: a2ui.dataMode })).not.toBeInTheDocument()
  })

  it("shows the current zoom level without needing a tooltip", () => {
    renderToolbar()
    expect(screen.getByText("100%")).toBeInTheDocument()
  })

  it("disables redo when redoStacks is empty for the active surface", () => {
    renderToolbar()
    const buttons = screen.getAllByRole("button")
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

  it("regenerate mode replaces the surface with the generated app", async () => {
    renderToolbar()

    fireEvent.click(screen.getByRole("button", { name: "AI Generate" }))
    fireEvent.click(screen.getByRole("button", { name: "Regenerate all" }))
    fireEvent.change(screen.getByPlaceholderText("Describe the app you want to build..."), {
      target: { value: "a habit tracker" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }))

    await waitFor(() => expect(replaceSurfaceContent).toHaveBeenCalled())
    expect(generateA2UIApp).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "create", surfaceId: "sx", instruction: "a habit tracker" })
    )
    expect(replaceSurfaceContent).toHaveBeenCalledWith(
      "sx",
      AI_RESULT.components,
      AI_RESULT.dataModel,
      "root"
    )
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(toast.success).toHaveBeenCalled()
  })

  it("regenerate mode surfaces a fallback toast when a template was used", async () => {
    generateA2UIApp.mockResolvedValueOnce({ ...AI_RESULT, usedFallback: true })
    renderToolbar()

    fireEvent.click(screen.getByRole("button", { name: "AI Generate" }))
    fireEvent.click(screen.getByRole("button", { name: "Regenerate all" }))
    fireEvent.change(screen.getByPlaceholderText("Describe the app you want to build..."), {
      target: { value: "a calculator" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }))

    await waitFor(() => expect(toast.info).toHaveBeenCalled())
  })

  it("edit mode applies an incremental AI edit and reconciles the tree", async () => {
    renderToolbar()

    fireEvent.click(screen.getByRole("button", { name: "AI Generate" }))
    // default mode is edit
    fireEvent.change(screen.getByPlaceholderText("Describe what you want to change..."), {
      target: { value: "make the header red" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }))

    await waitFor(() => expect(updateComponents).toHaveBeenCalled())
    expect(generateA2UIApp).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "edit",
        surfaceId: "sx",
        currentComponents: [{ id: "root" }, { id: "header" }],
      })
    )
    expect(updateComponents).toHaveBeenCalledWith("sx", AI_RESULT.components)
    expect(updateDataModel).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalled()
  })

  describe("AI edit data preservation", () => {
    const initialData = {
      profile: { name: "Ada", email: "ada@example.test" },
      draft: "Keep this draft",
    }

    it.each<{
      name: string
      updates: A2UIUpdateDataModelMessage[]
      capturedData: Record<string, unknown>
      expectedData: Record<string, unknown>
    }>([
      {
        name: "preserves existing form values for a component-only edit",
        updates: [],
        capturedData: {},
        expectedData: initialData,
      },
      {
        name: "preserves untouched values when an edit streams a nested data patch",
        updates: [
          {
            type: "dataModelUpdate",
            surfaceId: "sx",
            data: { profile: { name: "Grace" } },
            merge: true,
          },
        ],
        capturedData: { profile: { name: "Grace" } },
        expectedData: {
          profile: { name: "Grace", email: "ada@example.test" },
          draft: "Keep this draft",
        },
      },
      {
        name: "respects an explicit data replacement streamed by the edit",
        updates: [
          {
            type: "dataModelUpdate",
            surfaceId: "sx",
            data: { profile: { name: "Grace" } },
            merge: false,
          },
        ],
        capturedData: { profile: { name: "Grace" } },
        expectedData: { profile: { name: "Grace" } },
      },
    ])("$name", async ({ updates, capturedData, expectedData }) => {
      const { useA2UIStore: realStore } =
        jest.requireActual<typeof import("@/stores/a2ui")>("@/stores/a2ui")
      realStore.setState(realStore.getInitialState(), true)
      realStore.getState().createSurface("sx", "inline")
      realStore.getState().updateComponents("sx", [
        { id: "root", component: "Column", children: ["header"] },
        { id: "header", component: "Text", text: "Original heading" },
      ])
      realStore.getState().updateDataModel("sx", initialData, false)
      storeState.surfaces = realStore.getState().surfaces
      updateComponents.mockImplementation(realStore.getState().updateComponents)
      updateDataModel.mockImplementation(realStore.getState().updateDataModel)
      ;(streamDispatchToStore as jest.Mock).mockImplementation((message: A2UIDispatchMessage) =>
        realStore.getState().processMessage(message)
      )
      const editedHeader = { id: "header", component: "Text" as const, text: "Updated heading" }
      generateA2UIApp.mockImplementationOnce(
        async ({ onDispatch }: { onDispatch: (message: A2UIDispatchMessage) => void }) => {
          onDispatch({ type: "updateComponents", surfaceId: "sx", components: [editedHeader] })
          for (const update of updates) onDispatch(update)
          return { ...AI_RESULT, components: [editedHeader], dataModel: capturedData }
        }
      )
      renderToolbar()

      fireEvent.click(screen.getByRole("button", { name: "AI Generate" }))
      fireEvent.change(screen.getByPlaceholderText("Describe what you want to change..."), {
        target: { value: "change the heading" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Apply edit" }))

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("AI edit applied"))
      const surface = realStore.getState().surfaces.sx
      expect(surface.components.header).toEqual(editedHeader)
      expect(surface.dataModel).toEqual(expectedData)
      realStore.getState().deleteSurface("sx")
    })
  })

  it("reports partial changes when generation fails after dispatching an edit", async () => {
    generateA2UIApp.mockImplementationOnce(
      async ({ onDispatch }: { onDispatch: (message: A2UIDispatchMessage) => void }) => {
        onDispatch({
          type: "updateComponents",
          surfaceId: "sx",
          components: [{ id: "header", component: "Text", text: "Partial heading" }],
        })
        throw new A2UIAiUnavailableError("turn-failed")
      }
    )
    renderToolbar()
    fireEvent.click(screen.getByRole("button", { name: "AI Generate" }))
    fireEvent.change(screen.getByPlaceholderText("Describe what you want to change..."), {
      target: { value: "change heading" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "AI stopped after applying part of the change. Review the current draft before retrying."
      )
    )
    expect(streamDispatchToStore).toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("edit mode toasts an error and leaves the surface untouched when AI is unavailable", async () => {
    generateA2UIApp.mockRejectedValueOnce(new A2UIAiUnavailableError("no-transport"))
    renderToolbar()

    fireEvent.click(screen.getByRole("button", { name: "AI Generate" }))
    fireEvent.change(screen.getByPlaceholderText("Describe what you want to change..."), {
      target: { value: "make it fancy" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(updateComponents).not.toHaveBeenCalled()
    expect(replaceSurfaceContent).not.toHaveBeenCalled()
  })

  it("saves the current app as a template", async () => {
    renderToolbar()
    fireEvent.click(screen.getByRole("button", { name: "Save as template" }))
    await waitFor(() => expect(saveAsTemplate).toHaveBeenCalledWith("sx"))
    expect(toast.success).toHaveBeenCalled()
  })

  it("share opens the dialog and creates an a2ui link from the exported app", async () => {
    exportApp.mockReturnValue('{"app":{"name":"My App"}}')
    createShareLink.mockResolvedValue({ code: "C", url: "https://share.test/v/C#k=K" })
    renderToolbar()

    const shareButton = screen.getByRole("button", { name: "Share" })
    fireEvent.click(shareButton)

    fireEvent.click(await screen.findByRole("button", { name: "Create link" }))
    await screen.findByText("Your share link is ready")
    expect(exportApp).toHaveBeenCalledWith("sx")
    expect(createShareLink).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ kind: "a2ui", title: "My App" }),
      }),
      undefined
    )
  })
})
