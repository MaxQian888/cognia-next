import { render as rtlRender, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import userEvent from "@testing-library/user-event"

import type { ImageWorkbench as WorkbenchApi } from "@/hooks/chat/use-image-workbench"

const workbenchState: { current: WorkbenchApi } = { current: null as never }
jest.mock("@/hooks/chat/use-image-workbench", () => ({
  useImageWorkbench: () => workbenchState.current,
}))

import { ImageWorkbench, type ImageWorkbenchProps } from "./image-workbench"

function api(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  return {
    status: "ready",
    blocked: null,
    previewUrl: "blob:preview",
    originalUrl: "blob:original",
    size: { width: 800, height: 600 },
    state: { originCheckpointId: null, baked: [], entries: [], cursor: 0 },
    canUndo: false,
    canRedo: false,
    isDirty: false,
    apply: jest.fn(),
    undo: jest.fn(),
    redo: jest.fn(),
    reset: jest.fn(),
    jump: jest.fn(),
    ai: {
      capabilities: { options: [], preferred: null, unavailable: { reason: "no-provider" } },
      running: false,
      error: null,
      capability: null,
      selectCapability: jest.fn(),
      run: jest.fn(),
      runRegion: jest.fn(),
      cancel: jest.fn(),
    },
    save: { saving: false, error: null, run: jest.fn(async () => true) },
    ...overrides,
  } as WorkbenchApi
}

function props(overrides: Partial<ImageWorkbenchProps> = {}): ImageWorkbenchProps {
  return {
    open: true,
    onOpenChange: jest.fn(),
    source: {
      url: "cognia-media:a",
      lineageId: "cognia-media:a",
      parentVersionId: null,
      mediaType: "image/png",
    },
    target: { sessionId: "s1", messageId: "m1", canSave: true },
    saveBlockedReason: null,
    rail: [
      {
        url: "cognia-media:a",
        displayUrl: "blob:a",
        lineageId: "cognia-media:a",
        depth: 0,
        operations: [],
      },
    ],
    onSelectVersion: jest.fn(),
    canGoPrevious: false,
    canGoNext: false,
    onPrevious: jest.fn(),
    onNext: jest.fn(),
    onDownload: jest.fn(),
    title: "photo.png",
    ...overrides,
  }
}

/**
 * `TooltipProvider` is mounted once in `app/layout.tsx`, so the toolbar's
 * tooltip buttons have an ancestor in production and none in a bare render.
 */
function render(ui: React.ReactElement) {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>)
}

beforeEach(() => {
  workbenchState.current = api()
})

describe("ImageWorkbench", () => {
  it("opens on the viewing tool, with the stage and the rail present", () => {
    render(<ImageWorkbench {...props()} />)
    expect(screen.getByTestId("workbench-stage")).toHaveAttribute("data-mode", "view")
    expect(screen.getByTestId("workbench-version-rail")).toBeInTheDocument()
    expect(screen.getByTestId("workbench-view-hint")).toHaveTextContent("800 x 600 pixels")
  })

  it("puts the stage in crop mode when the crop tool is chosen", async () => {
    render(<ImageWorkbench {...props()} />)
    await userEvent.click(screen.getByRole("tab", { name: /crop/i }))
    expect(screen.getByTestId("workbench-transform-panel")).toBeInTheDocument()
    expect(screen.getByTestId("workbench-stage")).toHaveAttribute("data-mode", "crop")
  })

  it("keeps saving disabled until something has been edited", () => {
    render(<ImageWorkbench {...props()} />)
    expect(screen.getByTestId("workbench-save")).toBeDisabled()
  })

  it("saves once there are edits", async () => {
    const save = { saving: false, error: null, run: jest.fn(async () => true) }
    workbenchState.current = api({ isDirty: true, save })
    render(<ImageWorkbench {...props()} />)
    await userEvent.click(screen.getByTestId("workbench-save"))
    expect(save.run).toHaveBeenCalled()
  })

  it("explains a blocked save instead of hiding the button", () => {
    // Vanishing controls collapse "cannot yet" and "never could" into one
    // silent state, so the button stays and says which it is.
    workbenchState.current = api({ isDirty: true })
    render(<ImageWorkbench {...props({ saveBlockedReason: "streaming" })} />)
    expect(screen.getByTestId("workbench-save")).toBeDisabled()
    expect(screen.getByTestId("workbench-save-blocked")).toHaveTextContent("still streaming")
  })

  it("says a read-only conversation cannot take a version", () => {
    workbenchState.current = api({ isDirty: true })
    render(<ImageWorkbench {...props({ saveBlockedReason: "read-only" })} />)
    expect(screen.getByTestId("workbench-save-blocked")).toHaveTextContent("read-only")
  })

  it("closes straight away when nothing was edited", async () => {
    const onOpenChange = jest.fn()
    render(<ImageWorkbench {...props({ onOpenChange })} />)
    await userEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("asks before discarding unsaved edits", async () => {
    const onOpenChange = jest.fn()
    workbenchState.current = api({ isDirty: true })
    render(<ImageWorkbench {...props({ onOpenChange })} />)

    await userEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByTestId("workbench-discard")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("can back out of discarding and keep editing", async () => {
    const onOpenChange = jest.fn()
    workbenchState.current = api({ isDirty: true })
    render(<ImageWorkbench {...props({ onOpenChange })} />)
    await userEvent.click(screen.getByRole("button", { name: "Close" }))
    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }))
    expect(screen.queryByTestId("workbench-discard")).not.toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("marks the rail while an edit is unsaved", () => {
    workbenchState.current = api({ isDirty: true })
    render(<ImageWorkbench {...props()} />)
    expect(screen.getByTestId("workbench-version-draft")).toBeInTheDocument()
  })

  it("wires undo and redo to the history", async () => {
    const current = api({ canUndo: true, canRedo: true })
    workbenchState.current = current
    render(<ImageWorkbench {...props()} />)
    await userEvent.click(screen.getByRole("button", { name: "Undo" }))
    await userEvent.click(screen.getByRole("button", { name: "Redo" }))
    expect(current.undo).toHaveBeenCalled()
    expect(current.redo).toHaveBeenCalled()
  })

  it("explains a cross-origin image that can be viewed but not edited", () => {
    workbenchState.current = api({ blocked: "cors" })
    render(<ImageWorkbench {...props()} />)
    expect(screen.getByTestId("workbench-blocked")).toHaveTextContent("cannot be read")
    expect(screen.getByTestId("workbench-preview")).toBeInTheDocument()
  })

  it("still offers a download for an image it cannot edit", async () => {
    const onDownload = jest.fn()
    workbenchState.current = api({ blocked: "cors" })
    render(<ImageWorkbench {...props({ onDownload })} />)
    await userEvent.click(screen.getByRole("button", { name: "Download" }))
    expect(onDownload).toHaveBeenCalled()
  })

  it("shows the AI panel's reason when no provider is configured", async () => {
    render(<ImageWorkbench {...props()} />)
    await userEvent.click(screen.getByRole("tab", { name: "AI" }))
    expect(screen.getByTestId("workbench-ai-unavailable")).toHaveTextContent(
      "No image-editing provider"
    )
  })

  it("pages between images when there are neighbours", async () => {
    const onNext = jest.fn()
    render(<ImageWorkbench {...props({ canGoNext: true, onNext })} />)
    await userEvent.click(screen.getByRole("button", { name: "Next image" }))
    expect(onNext).toHaveBeenCalled()
  })

  it("surfaces a save failure", () => {
    workbenchState.current = api({
      isDirty: true,
      save: { saving: false, error: "offline", run: jest.fn() },
    })
    render(<ImageWorkbench {...props()} />)
    expect(screen.getByTestId("workbench-save-error")).toHaveTextContent("offline")
  })
})
