// An action command that uses a staged file (`/video`'s start frame, ADR-0205)
// takes it out of the turn the composer sends after the batch. The handler is
// stubbed; what is under test is the composer handing it the staged files and
// honouring what it consumed.

// The first full Composer mount in this file costs ~7s under parallel workers
// (module graph + Radix subtrees), which overruns the 5s default and then
// cascades — the timed-out test leaves React mid-act, so every later render
// yields a null textarea. Same 30s budget the other full-Composer suites use.
jest.setTimeout(30_000)

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
const videoHandler = jest.fn()
jest.mock("@/lib/slash-commands/actions/video", () => ({
  VIDEO_COMMAND_PARAMS: [],
  handleVideoCommand: (...args: unknown[]) => videoHandler(...args),
}))
// Stubbed for cost, not correctness: the attach menu is covered by its own
// suite, and mounting its Radix subtree on every render here pushed the first
// (cold) test past the 5s default timeout under parallel workers.
jest.mock("./composer/attach-menu", () => ({ ComposerAttachMenu: () => null }))
jest.mock("./composer/voice-controls", () => ({ VoiceControls: () => null }))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))
jest.mock("@/lib/chat/attachments/dispatch", () => ({
  INLINE_TOKEN_CEILING: 12_000,
  buildSendContent: jest.fn(),
  extractedFromVideoResult: jest.fn(() => ({ kind: "video", block: null, tokens: 0 })),
}))
jest.mock("@/lib/chat/attachments/video/preprocess", () => ({
  preprocessMotionAttachment: jest.fn(),
}))
// The verdict itself is the hook's own suite; here it only has to reach the send.
jest.mock("./composer/hooks/use-composer-video-route", () => ({
  useComposerVideoRoute: jest.fn(() => ({
    facts: {},
    verdict: { available: false, reason: "runtime" },
  })),
}))
// Passthrough by default — one test below overrides it with a deferred promise
// to hold preparation open and inspect the in-flight placeholder chip.
jest.mock("@/lib/chat/attachments/prepare", () => {
  const actual = jest.requireActual("@/lib/chat/attachments/prepare")
  return { ...actual, prepareComposerAttachments: jest.fn(actual.prepareComposerAttachments) }
})
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

import { act, fireEvent, render, waitFor } from "@testing-library/react"
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

describe("Composer — staged files taken by an action command", () => {
  it("hands the staged files to the command and sends nothing once it took them", async () => {
    videoHandler.mockImplementation(
      (ctx: { stagedFiles?: { id: string }[]; consumeStagedFiles?: (ids: string[]) => void }) => {
        ctx.consumeStagedFiles?.(ctx.stagedFiles!.map((file) => file.id))
      }
    )
    const onSend = jest.fn(async () => undefined)
    const ta = renderComposer(onSend)
    await stageImage("frame.png")

    await typeAndEnter(ta, "/video a paper boat")

    expect(videoHandler).toHaveBeenCalledTimes(1)
    const ctx = videoHandler.mock.calls[0][0]
    expect(ctx.args).toBe("a paper boat")
    expect(ctx.stagedFiles).toEqual([
      expect.objectContaining({ url: "blob:mock", mediaType: "image/png", filename: "frame.png" }),
    ])
    expect(onSend).not.toHaveBeenCalled()
    expect(buildSendContentMock).not.toHaveBeenCalled()
    expect(ta.value).toBe("")
  })

  it("still sends a staged file the command left alone", async () => {
    buildSendContentMock.mockResolvedValue({ content: "x", rejected: [], tokens: 0, manifest: [] })
    videoHandler.mockImplementation(() => undefined)
    const onSend = jest.fn(async () => undefined)
    const ta = renderComposer(onSend)
    await stageImage("frame.png")

    await typeAndEnter(ta, "/video a paper boat")

    expect(videoHandler).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(buildSendContentMock).toHaveBeenCalled())
    expect(buildSendContentMock.mock.calls[0][1]).toEqual([
      expect.objectContaining({ filename: "frame.png" }),
    ])
  })
})
