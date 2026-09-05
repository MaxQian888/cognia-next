import { render as rtlRender, screen, waitFor } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { ASPECT_PRESETS } from "@/lib/images"

import { ADJUSTMENT_SLIDERS } from "./workbench-panels"
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
    exportImage: { run: jest.fn(async () => new Blob(["x"], { type: "image/png" })) },
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

jest.mock("@/lib/files/download", () => ({ downloadFromUrl: jest.fn(async () => undefined) }))

beforeEach(() => {
  workbenchState.current = api()
  // jsdom implements neither, and the download path uses both.
  globalThis.URL.createObjectURL = jest.fn(() => "blob:export")
  globalThis.URL.revokeObjectURL = jest.fn()
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
    workbenchState.current = api({ blocked: "cors" })
    render(<ImageWorkbench {...props()} />)
    await userEvent.click(screen.getByTestId("workbench-download"))
    expect(await screen.findByText("Download as PNG")).toBeInTheDocument()
  })

  it("offers every format the engine can write, and downloads the current render", async () => {
    const current = api({ isDirty: true })
    workbenchState.current = current
    render(<ImageWorkbench {...props()} />)

    await userEvent.click(screen.getByTestId("workbench-download"))
    for (const label of ["Download as PNG", "Download as JPEG", "Download as WEBP"]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }

    await userEvent.click(screen.getByText("Download as JPEG"))
    expect(current.exportImage.run).toHaveBeenCalledWith("jpeg")
    // The object URL it minted is released rather than pinned for the session.
    await waitFor(() => expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith("blob:export"))
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

  it("translates a save failure and keeps the underlying message as detail", () => {
    // The raw `Error.message` used to be the whole alert, which put an
    // untranslated exception string in front of the user.
    workbenchState.current = api({
      isDirty: true,
      save: {
        saving: false,
        error: { code: "locked", detail: "Session s1 is read-only" },
        run: jest.fn(),
      },
    })
    render(<ImageWorkbench {...props()} />)
    const alert = screen.getByTestId("workbench-save-error")
    expect(alert).toHaveTextContent("locked while it moves to another device")
    expect(alert).toHaveTextContent("Session s1 is read-only")
  })

  it("has a translation for every save failure code", () => {
    for (const code of [
      "locked",
      "message-missing",
      "lineage-missing",
      "too-large",
      "unknown",
    ] as const) {
      workbenchState.current = api({
        isDirty: true,
        save: { saving: false, error: { code, detail: "d" }, run: jest.fn() },
      })
      const view = render(<ImageWorkbench {...props()} />)
      expect(screen.getByTestId("workbench-save-error").textContent).not.toContain(
        `save.error.${code}`
      )
      view.unmount()
    }
  })
})

/**
 * Five key families are looked up through template literals, which
 * `lint:i18n` cannot see through. Without this, adding an aspect preset or a
 * block reason ships a raw key path to users with every gate green. Both
 * locales, because the mock resolves against English only and a zh-CN gap
 * would otherwise be invisible here.
 */
describe("dynamically-looked-up translation keys", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const en = require("@/i18n/messages/en/chat.json") as Record<string, never>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zh = require("@/i18n/messages/zh-CN/chat.json") as Record<string, never>

  function at(root: Record<string, never>, path: string): unknown {
    return path
      .split(".")
      .reduce<unknown>(
        (node, key) => (node as Record<string, unknown> | undefined)?.[key],
        root.imageWorkbench
      )
  }

  const FAMILIES: Array<[string, readonly string[]]> = [
    ["tools", ["view", "transform", "adjust", "ai"]],
    ["blocked", ["cors", "unsupported", "decode"]],
    ["crop.aspect", ASPECT_PRESETS.map((preset) => preset.id)],
    ["adjust", ADJUSTMENT_SLIDERS.map((slider) => slider.key as string)],
    ["ai.unavailable", ["no-provider", "needs-auth", "needs-config"]],
  ]

  it.each(FAMILIES)("resolves every %s key in both locales", (prefix, keys) => {
    for (const key of keys) {
      expect(typeof at(en, `${prefix}.${key}`)).toBe("string")
      expect(typeof at(zh, `${prefix}.${key}`)).toBe("string")
    }
  })

  it("carries no key a source union does not produce", () => {
    // The other direction: a preset removed from the engine should not leave a
    // stale entry behind pretending to be covered.
    const aspects = Object.keys(at(en, "crop.aspect") as Record<string, string>)
    expect(aspects.sort()).toEqual(ASPECT_PRESETS.map((preset) => preset.id).sort())
    const sliders = Object.keys(at(en, "adjust") as Record<string, string>).filter(
      (key) => key !== "reset"
    )
    expect(sliders.sort()).toEqual(ADJUSTMENT_SLIDERS.map((slider) => slider.key).sort())
  })
})
