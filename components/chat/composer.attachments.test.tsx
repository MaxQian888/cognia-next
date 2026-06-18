// Covers the composer's attachment send contract added with the dispatch work:
//  - a normal turn resolves onSubmit→true and clears the input
//  - an oversize turn parks on a confirm dialog; "Send anyway" sends, "Cancel"
//    keeps the draft intact (decision: warn + confirm, never silently truncate)
//
// buildSendContent is mocked so we can force the token total without staging a
// real binary attachment (blob→data-url conversion isn't available in jsdom).

jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: jest.fn(async () => []),
}))
jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
  formatSearchResultsForLLM: jest.fn(),
}))
jest.mock("@/lib/shell/exec", () => ({
  executeShell: jest.fn(),
  formatShellResult: jest.fn(),
}))
jest.mock("@/lib/files/memory", () => ({ appendMemory: jest.fn() }))
jest.mock("./composer/screenshot-button", () => ({ ScreenshotButton: () => null }))
jest.mock("./composer/voice-controls", () => ({ VoiceControls: () => null }))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))
jest.mock("@/lib/chat/attachments/dispatch", () => ({
  INLINE_TOKEN_CEILING: 12_000,
  buildSendContent: jest.fn(),
}))
// The draft helpers hit Dexie; stub them so clearAfterSend()'s floating
// clearDraft() can't reject into an unhandled-rejection that fails the test.
jest.mock("@/lib/db/chat-drafts", () => ({
  clearDraft: jest.fn(async () => undefined),
  getDraft: jest.fn(async () => null),
  setDraftDebounced: jest.fn(),
}))

import { act, fireEvent, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { buildSendContent } from "@/lib/chat/attachments/dispatch"
import type { ChatSession } from "@/lib/claude/types"

const buildSendContentMock = buildSendContent as jest.Mock

function makeAdapter(): DataAdapter {
  return {
    useCharacters: () => undefined,
    useCharacter: () => undefined,
    useSkillsByIds: () => undefined,
    usePresets: () => undefined,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
  }
}

function renderComposer(onSend: (c: unknown) => Promise<void>) {
  const session: ChatSession = {
    id: "ses_1",
    title: "Attachments Test",
    kind: "direct",
    permissionMode: undefined,
    createdAt: 0,
    updatedAt: 0,
  }
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={makeAdapter()}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
  render(
    <Wrapper>
      <Composer
        session={session}
        onStartNewSession={async () => undefined}
        onOpenSettings={() => undefined}
        onSend={onSend}
        onStop={async () => undefined}
      />
    </Wrapper>
  )
  return document.querySelector("textarea") as HTMLTextAreaElement
}

async function typeAndEnter(ta: HTMLTextAreaElement, value: string) {
  await act(async () => {
    fireEvent.change(ta, { target: { value } })
    fireEvent.keyDown(ta, { key: "Enter" })
    await new Promise((r) => setTimeout(r, 50))
  })
}

async function clickButton(label: string) {
  const btn = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label
  )
  if (!btn) throw new Error(`button "${label}" not found`)
  await act(async () => {
    fireEvent.click(btn)
    await new Promise((r) => setTimeout(r, 50))
  })
}

function dialogOpen(): boolean {
  return document.body.querySelector('[role="alertdialog"]') !== null
}

beforeEach(() => {
  useChatStore.getState().clear()
  buildSendContentMock.mockReset()
})

describe("Composer — attachment send contract", () => {
  it("sends a normal turn and clears the input", async () => {
    buildSendContentMock.mockResolvedValue({ content: "hi", rejected: [], tokens: 0 })
    const onSend = jest.fn(async () => undefined)
    const ta = renderComposer(onSend)

    await typeAndEnter(ta, "hi")

    expect(onSend).toHaveBeenCalledWith("hi")
    expect(dialogOpen()).toBe(false)
    expect(ta.value).toBe("")
  })

  it("parks on a confirm dialog for an oversize turn and sends on confirm", async () => {
    buildSendContentMock.mockResolvedValue({
      content: [{ type: "text", text: "big" }],
      rejected: [],
      tokens: 20_000,
    })
    const onSend = jest.fn(async () => undefined)
    const ta = renderComposer(onSend)

    await typeAndEnter(ta, "x")
    expect(dialogOpen()).toBe(true)
    expect(onSend).not.toHaveBeenCalled()

    await clickButton("Send anyway")
    expect(onSend).toHaveBeenCalledWith([{ type: "text", text: "big" }])
  })

  it("keeps the draft when the user cancels the oversize dialog", async () => {
    buildSendContentMock.mockResolvedValue({
      content: [{ type: "text", text: "big" }],
      rejected: [],
      tokens: 20_000,
    })
    const onSend = jest.fn(async () => undefined)
    const ta = renderComposer(onSend)

    await typeAndEnter(ta, "x")
    expect(dialogOpen()).toBe(true)

    await clickButton("Cancel")
    expect(dialogOpen()).toBe(false)
    expect(onSend).not.toHaveBeenCalled()
    expect(ta.value).toBe("x")
  })
})
