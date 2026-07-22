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
jest.mock("@/lib/chat/link-context", () => ({
  ...jest.requireActual("@/lib/chat/link-context"),
  buildLinkContextBlocks: jest.fn(async () => ({ blocks: [], rejected: [], tokens: 0 })),
}))
// The draft helpers hit Dexie; stub them so clearAfterSend()'s floating
// clearDraft() can't reject into an unhandled-rejection that fails the test.
jest.mock("@/lib/db/chat-drafts", () => ({
  clearDraft: jest.fn(async () => undefined),
  getDraft: jest.fn(async () => null),
  setDraftDebounced: jest.fn(),
}))

import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { buildSendContent } from "@/lib/chat/attachments/dispatch"
import { buildLinkContextBlocks } from "@/lib/chat/link-context"
import type { ChatSession } from "@cognia/agent-config-types"

const buildSendContentMock = buildSendContent as jest.Mock
const buildLinkContextBlocksMock = buildLinkContextBlocks as jest.Mock

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

// Stage an image attachment through the hidden file input, exactly as the
// paperclip button does. jsdom has no object-URL support, so it is polyfilled
// in beforeEach below.
async function stageImage(name = "shot.png") {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(["x"], name, { type: "image/png" })
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
    await new Promise((r) => setTimeout(r, 0))
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
  // Reset composer settings to defaults (clearAfterSend on) so per-test overrides
  // don't leak between cases.
  useSettingsStore.setState({ settings: undefined })
  buildSendContentMock.mockReset()
  buildLinkContextBlocksMock.mockReset()
  buildLinkContextBlocksMock.mockResolvedValue({ blocks: [], rejected: [], tokens: 0 })
  // jsdom lacks object-URL support; the composer creates one per staged file.
  global.URL.createObjectURL = jest.fn(() => "blob:mock")
  global.URL.revokeObjectURL = jest.fn()
})

describe("Composer — attachment send contract", () => {
  it("appends readable context for recognized links while keeping the URL in the prompt", async () => {
    buildSendContentMock.mockResolvedValue({
      content: "Read https://example.com/docs",
      rejected: [],
      tokens: 0,
    })
    buildLinkContextBlocksMock.mockResolvedValue({
      blocks: [{ type: "text", text: "Linked page context" }],
      rejected: [],
      tokens: 4,
    })
    const onSend = jest.fn(async () => undefined)
    const ta = renderComposer(onSend)

    await typeAndEnter(ta, "Read https://example.com/docs")

    expect(buildLinkContextBlocksMock).toHaveBeenCalledWith("Read https://example.com/docs")
    expect(onSend).toHaveBeenCalledWith([
      { type: "text", text: "Read https://example.com/docs" },
      { type: "text", text: "Linked page context" },
    ])
  })

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

  // Regression: a cancelled/failed send must not destroy staged attachments.
  // The optimistic clear used to call attachments.clear() (which revokes the
  // blob URLs), so declining the oversize dialog silently deleted the images.
  it("keeps a staged attachment when the user cancels the oversize dialog", async () => {
    buildSendContentMock.mockResolvedValue({
      content: [{ type: "text", text: "big" }],
      rejected: [],
      tokens: 20_000,
    })
    const onSend = jest.fn(async () => undefined)
    const ta = renderComposer(onSend)

    await stageImage("shot.png")
    expect(screen.getByAltText("shot.png")).toBeInTheDocument()

    await typeAndEnter(ta, "x")
    expect(dialogOpen()).toBe(true)

    await clickButton("Cancel")
    expect(onSend).not.toHaveBeenCalled()
    expect(ta.value).toBe("x")
    // The attachment survives — it was NOT cleared/revoked by the optimistic clear.
    expect(screen.getByAltText("shot.png")).toBeInTheDocument()
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock")
  })

  it("clears a staged attachment only after a confirmed successful send", async () => {
    buildSendContentMock.mockResolvedValue({ content: "hi", rejected: [], tokens: 0 })
    const onSend = jest.fn(async () => undefined)
    const ta = renderComposer(onSend)

    await stageImage("shot.png")
    expect(screen.getByAltText("shot.png")).toBeInTheDocument()

    await typeAndEnter(ta, "hi")

    expect(onSend).toHaveBeenCalled()
    expect(ta.value).toBe("")
    // On a confirmed send the staged attachment is dropped and its blob revoked.
    // (Asserting the revoke is deterministic; the chip itself lingers briefly in
    // the DOM while its AnimatePresence exit animation plays.)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock")
  })

  it("keeps the text and attachment after sending when clearAfterSend is off", async () => {
    useSettingsStore.setState({
      settings: { composerBehavior: { clearAfterSend: false } } as never,
    })
    buildSendContentMock.mockResolvedValue({ content: "hi", rejected: [], tokens: 0 })
    const onSend = jest.fn(async () => undefined)
    const ta = renderComposer(onSend)

    await stageImage("shot.png")
    await typeAndEnter(ta, "hi")

    expect(onSend).toHaveBeenCalled()
    // clearAfterSend off: the composer keeps everything for a resend/tweak — no
    // optimistic clear, and finalizeSend must not drop/revoke the attachment.
    expect(ta.value).toBe("hi")
    expect(screen.getByAltText("shot.png")).toBeInTheDocument()
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock")
  })
})
