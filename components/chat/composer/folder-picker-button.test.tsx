jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "tauri") }))
jest.mock("@/lib/chat/folder-context", () => {
  const actual = jest.requireActual<typeof import("@/lib/chat/folder-context")>(
    "@/lib/chat/folder-context"
  )
  return { ...actual, pickFolder: jest.fn(), summarizeFolder: jest.fn() }
})

import { act, fireEvent, render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { FolderPickerButton } from "./folder-picker-button"
import { usePlatform } from "@/hooks/use-platform"
import { pickFolder, summarizeFolder, type FolderSummary } from "@/lib/chat/folder-context"
import { useChatStore } from "@/stores/chat"

const platformMock = usePlatform as jest.Mock
const pickMock = pickFolder as jest.Mock
const summarizeMock = summarizeFolder as jest.Mock

const summary = (over: Partial<FolderSummary> = {}): FolderSummary => ({
  absolute: "/repo/pkg",
  relative: "pkg",
  fileCount: 3,
  truncated: false,
  needsConfirm: false,
  ...over,
})

function renderButton() {
  return render(
    <TooltipProvider>
      <FolderPickerButton />
    </TooltipProvider>
  )
}

async function clickPick() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /add a folder/i }))
    await new Promise((r) => setTimeout(r, 30))
  })
}

async function clickLabel(label: string) {
  const btn = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label
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
})

describe("FolderPickerButton", () => {
  it("renders nothing off desktop", () => {
    platformMock.mockReturnValue("mobile")
    const { container } = renderButton()
    expect(container.firstChild).toBeNull()
  })

  it("adds a small folder as a reference without a dialog", async () => {
    pickMock.mockResolvedValue("/repo/pkg")
    summarizeMock.mockResolvedValue(summary())
    renderButton()

    await clickPick()

    expect(useChatStore.getState().referencedPaths).toEqual([
      { absolute: "/repo/pkg", relative: "pkg", isDir: true },
    ])
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it("does nothing when the picker is cancelled", async () => {
    pickMock.mockResolvedValue(null)
    renderButton()
    await clickPick()
    expect(summarizeMock).not.toHaveBeenCalled()
    expect(useChatStore.getState().referencedPaths).toEqual([])
  })

  it("confirms before adding a large folder", async () => {
    pickMock.mockResolvedValue("/repo/big")
    summarizeMock.mockResolvedValue(
      summary({ absolute: "/repo/big", relative: "big", fileCount: 250, needsConfirm: true })
    )
    renderButton()

    await clickPick()
    // Not added yet — the confirm dialog is up.
    expect(useChatStore.getState().referencedPaths).toEqual([])
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()

    await clickLabel("Add folder")
    expect(useChatStore.getState().referencedPaths).toEqual([
      { absolute: "/repo/big", relative: "big", isDir: true },
    ])
  })

  it("keeps the folder out when the confirm is cancelled", async () => {
    pickMock.mockResolvedValue("/repo/big")
    summarizeMock.mockResolvedValue(summary({ needsConfirm: true, fileCount: 300 }))
    renderButton()

    await clickPick()
    await clickLabel("Cancel")

    expect(useChatStore.getState().referencedPaths).toEqual([])
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })
})
