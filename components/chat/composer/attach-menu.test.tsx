jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "tauri") }))
jest.mock("@/lib/ui/screenshot", () => ({ captureScreenshot: jest.fn() }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputAttachments: jest.fn(() => ({ add: jest.fn(), files: [] })),
}))
jest.mock("@/lib/chat/folder-context", () => {
  const actual = jest.requireActual<typeof import("@/lib/chat/folder-context")>(
    "@/lib/chat/folder-context"
  )
  return { ...actual, pickFolder: jest.fn(), summarizeFolder: jest.fn() }
})
// Radix's Popover opens on pointer events, which jsdom doesn't emit for
// `fireEvent.click`. Flatten the primitives so the panel's contents are always
// visible and directly clickable (the pattern in
// agent/mode/runtime-selector.test.tsx).
jest.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { act, fireEvent, render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ComposerAttachMenu } from "./attach-menu"
import { usePlatform } from "@/hooks/use-platform"
import { pickFolder, summarizeFolder, type FolderSummary } from "@/lib/chat/folder-context"
import { captureScreenshot } from "@/lib/ui/screenshot"
import { toast } from "sonner"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { useChatStore } from "@/stores/chat"

const platformMock = usePlatform as jest.Mock
const pickMock = pickFolder as jest.Mock
const summarizeMock = summarizeFolder as jest.Mock
const captureMock = captureScreenshot as jest.Mock
const attachmentsMock = usePromptInputAttachments as unknown as jest.Mock
const addAttachment = jest.fn()

const summary = (over: Partial<FolderSummary> = {}): FolderSummary => ({
  absolute: "/repo/pkg",
  relative: "pkg",
  fileCount: 3,
  truncated: false,
  needsConfirm: false,
  ...over,
})

function renderMenu(
  onPickFiles = jest.fn(),
  capabilities: React.ReactNode = <div data-testid="composer-capabilities">Capabilities</div>
) {
  render(
    <TooltipProvider>
      <ComposerAttachMenu onPickFiles={onPickFiles} capabilities={capabilities} />
    </TooltipProvider>
  )
  return onPickFiles
}

async function clickLabel(label: string | RegExp) {
  const match = (text: string) => (typeof label === "string" ? text === label : label.test(text))
  const btn = Array.from(document.body.querySelectorAll("button")).find((b) =>
    match(b.textContent?.trim() ?? "")
  )!
  await act(async () => {
    fireEvent.click(btn)
    await new Promise((r) => setTimeout(r, 30))
  })
}

beforeEach(() => {
  useChatStore.getState().clear()
  platformMock.mockReturnValue("tauri")
  pickMock.mockReset()
  summarizeMock.mockReset()
  captureMock.mockReset()
  addAttachment.mockReset()
  ;(toast.error as jest.Mock).mockReset()
  attachmentsMock.mockReturnValue({ add: addAttachment, files: [] })
})

describe("ComposerAttachMenu", () => {
  it("offers files and folders behind one `+` on desktop", async () => {
    const onPickFiles = renderMenu()
    expect(screen.getByTestId("composer-attach-menu")).toBeInTheDocument()
    expect(screen.getByTestId("composer-capabilities")).toBeInTheDocument()

    await clickLabel("Upload files")
    expect(onPickFiles).toHaveBeenCalledTimes(1)
  })

  it("stages a screenshot as an attachment", async () => {
    const shot = new File(["x"], "screen.png", { type: "image/png" })
    captureMock.mockResolvedValue(shot)
    renderMenu()

    await clickLabel("Capture screenshot")

    expect(addAttachment).toHaveBeenCalledWith([shot])
  })

  it("stages nothing when the screen picker is cancelled", async () => {
    captureMock.mockResolvedValue(null)
    renderMenu()

    await clickLabel("Capture screenshot")

    expect(addAttachment).not.toHaveBeenCalled()
  })

  it("surfaces a failed capture instead of staging nothing silently", async () => {
    captureMock.mockRejectedValue(new Error("permission denied"))
    renderMenu()

    await clickLabel("Capture screenshot")

    expect(addAttachment).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith("permission denied")
  })

  it("keeps the composer usable when the folder dialog throws", async () => {
    pickMock.mockRejectedValue(new Error("dialog unavailable"))
    renderMenu()

    await clickLabel("Add folder")

    expect(useChatStore.getState().referencedPaths).toEqual([])
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it("drops the desktop-only branches on web but keeps the panel", async () => {
    platformMock.mockReturnValue("web")
    const onPickFiles = renderMenu()

    expect(screen.getByTestId("composer-attach-menu")).toBeInTheDocument()
    // No filesystem path to reference and no screen to capture in a browser tab.
    expect(screen.queryByText("Add folder")).toBeNull()
    expect(screen.queryByText("Capture screenshot")).toBeNull()

    await clickLabel("Upload files")
    expect(onPickFiles).toHaveBeenCalledTimes(1)
  })

  it("adds a small folder as a reference without a dialog", async () => {
    pickMock.mockResolvedValue("/repo/pkg")
    summarizeMock.mockResolvedValue(summary())
    renderMenu()

    await clickLabel("Add folder")

    expect(useChatStore.getState().referencedPaths).toEqual([
      { absolute: "/repo/pkg", relative: "pkg", isDir: true },
    ])
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it("does nothing when the folder picker is cancelled", async () => {
    pickMock.mockResolvedValue(null)
    renderMenu()

    await clickLabel("Add folder")

    expect(summarizeMock).not.toHaveBeenCalled()
    expect(useChatStore.getState().referencedPaths).toEqual([])
  })

  it("confirms before adding a large folder", async () => {
    pickMock.mockResolvedValue("/repo/big")
    summarizeMock.mockResolvedValue(
      summary({ absolute: "/repo/big", relative: "big", fileCount: 250, needsConfirm: true })
    )
    renderMenu()

    await clickLabel("Add folder")
    expect(useChatStore.getState().referencedPaths).toEqual([])
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()

    // The dialog's confirm carries the same label as the menu item, so target
    // the one inside the alert dialog.
    const confirm = Array.from(document.body.querySelectorAll('[role="alertdialog"] button')).find(
      (b) => b.textContent?.trim() === "Add folder"
    )!
    await act(async () => {
      fireEvent.click(confirm)
      await new Promise((r) => setTimeout(r, 30))
    })

    expect(useChatStore.getState().referencedPaths).toEqual([
      { absolute: "/repo/big", relative: "big", isDir: true },
    ])
  })

  it("keeps the folder out when the confirm is cancelled", async () => {
    pickMock.mockResolvedValue("/repo/big")
    summarizeMock.mockResolvedValue(summary({ needsConfirm: true, fileCount: 300 }))
    renderMenu()

    await clickLabel("Add folder")
    await clickLabel("Cancel")

    expect(useChatStore.getState().referencedPaths).toEqual([])
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })
})
