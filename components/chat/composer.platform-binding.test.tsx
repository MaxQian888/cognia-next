/**
 * @jest-environment jsdom
 *
 * Real Composer regression coverage for the unified platform send contract.
 */

import "fake-indexeddb/auto"

jest.mock("@/lib/db/connector-drafts", () => ({
  listPendingForConversation: jest.fn(async () => []),
}))
jest.mock("@/components/inbox/canned-response-picker", () => ({ CannedResponsePicker: () => null }))
// The draft dialog's body is the inbox's editor, with its own suite; here it
// only has to show up when the review button opens the dialog.
jest.mock("@/components/inbox/draft-editor", () => ({
  DraftEditor: ({ draft }: { draft: { id: string } }) => (
    <div data-testid={`draft-editor-${draft.id}`} />
  ),
}))
jest.mock("@/components/inbox/inbox-composer-actions-host", () => ({
  InboxComposerActionsHost: () => null,
}))

jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: jest.fn(async () => []),
}))
jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
  formatSearchResultsForLLM: jest.fn(() => "Search result body"),
}))
jest.mock("@/lib/search/configured-search", () => ({
  searchWithAppSettings: jest.fn(),
}))
jest.mock("@/lib/shell/exec", () => ({
  executeShell: jest.fn(),
  formatShellResult: jest.fn(),
}))
jest.mock("@/lib/files/memory", () => ({
  appendMemory: jest.fn(),
}))
jest.mock("./composer/voice-controls", () => ({
  VoiceControls: () => null,
}))
const mockWaitForStagedAttachments = jest.fn(async (): Promise<void> => undefined)
jest.mock("./composer/staged-attachment-store", () => {
  const actual = jest.requireActual("./composer/staged-attachment-store")
  const { useMemo } = jest.requireActual("react")
  return {
    ...actual,
    useStagedAttachments() {
      const staged = actual.useStagedAttachments()
      return useMemo(() => ({ ...staged, whenSettled: mockWaitForStagedAttachments }), [staged])
    },
  }
})
// Make the send pipeline deterministic: plain text in → that text as content.
jest.mock("@/lib/chat/attachments/dispatch", () => ({
  ...jest.requireActual("@/lib/chat/attachments/dispatch"),
  buildSendContent: jest.fn(async (text: string) => ({
    content: text,
    rejected: [],
    tokens: 1,
    manifest: [],
  })),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { selectComposerReplyTo, useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listInputHistory } from "@/lib/db/chat-input-history"
import type { ChatSession } from "@cognia/agent-config-types"

function makeAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    useCharacters: () => undefined,
    useCharacter: () => undefined,
    useSkillsByIds: () => undefined,
    usePresets: () => undefined,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
    ...overrides,
  }
}

function withAdapter(adapter: DataAdapter) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
  Wrapper.displayName = "ComposerBehaviorWrapper"
  return Wrapper
}

const mkSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: "ses_behavior",
  title: "Behavior",
  kind: "direct",
  permissionMode: undefined,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

function renderComposer(session: ChatSession, onSend = jest.fn(async () => undefined)) {
  const Wrapper = withAdapter(makeAdapter())
  const composer = (currentSession: ChatSession) => (
    <Wrapper>
      <Composer
        session={currentSession}
        onStartNewSession={async () => undefined}
        onOpenSettings={() => undefined}
        onSend={onSend}
        onStop={async () => undefined}
      />
    </Wrapper>
  )
  const view = render(composer(session))
  const ta = document.querySelector("textarea") as HTMLTextAreaElement
  return { ta, onSend, switchSession: (next: ChatSession) => view.rerender(composer(next)) }
}

// The first full Composer mount in the test body costs as much as the cold-open
// hook below and overruns the 5s default the same way under parallel workers,
// so the file gets the same 30s budget.
jest.setTimeout(30_000)

// Cold-open Dexie (delete + reopen + migrate the full schema) can exceed the
// default 5s hook budget on the first test of the file — repo convention is a
// 30s hook timeout for suites that reset the DB per test.
beforeEach(async () => {
  jest.clearAllMocks()
  mockWaitForStagedAttachments.mockResolvedValue(undefined)
  useSettingsStore.setState({ settings: { composerBehavior: { persistDrafts: false } } as never })
  useChatStore.getState().clear()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

afterEach(() => {
  useSettingsStore.setState({ settings: undefined as never })
})

jest.mock("@/lib/inbox/manual-send", () => ({
  ...jest.requireActual("@/lib/inbox/manual-send"),
  sendManualMessageToConversation: jest.fn(),
}))
jest.mock("@/lib/connectors/inbox-writes", () => ({
  ...jest.requireActual("@/lib/connectors/inbox-writes"),
  useInboxWriteReadiness: () => ({
    route: "remote",
    hostSupported: true,
    availability: { state: "available" },
  }),
}))
import {
  sendManualMessageToConversation,
  UnsupportedPlatformAttachmentsError,
} from "@/lib/inbox/manual-send"
import { toast } from "sonner"

const boundSession = () =>
  mkSession({
    platformBinding: {
      platform: "telegram",
      adapterId: "bot",
      conversationKey: "telegram:bot:chat",
      conversationRef: { platform: "telegram", adapterId: "bot", chatId: "chat" },
    },
  })

it.each([false, true])(
  "snapshots the reply before preparation (initial reply: %s)",
  async (hasReply) => {
    let finishPreparation!: () => void
    mockWaitForStagedAttachments.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishPreparation = resolve
      })
    )
    ;(sendManualMessageToConversation as jest.Mock).mockResolvedValueOnce({ route: "remote" })
    const session = boundSession()
    const originalReply = hasReply ? { messageId: "original", preview: "Original" } : null
    const nextReply = { messageId: "next", preview: "Next" }
    useChatStore.getState().setReplyTo(originalReply, session.id)
    const { ta } = renderComposer(session)
    fireEvent.change(ta, { target: { value: "Submitted reply" } })
    fireEvent.keyDown(ta, { key: "Enter" })
    await waitFor(() => expect(mockWaitForStagedAttachments).toHaveBeenCalled())
    expect(sendManualMessageToConversation).not.toHaveBeenCalled()
    act(() => useChatStore.getState().setReplyTo(nextReply, session.id))
    await act(async () => finishPreparation())
    await waitFor(() =>
      expect(sendManualMessageToConversation).toHaveBeenCalledWith(
        expect.objectContaining({ replyTo: originalReply })
      )
    )
    expect(selectComposerReplyTo(useChatStore.getState(), session.id)).toEqual(nextReply)
  }
)

it("recalls the full folded paste after a failed platform send", async () => {
  let fail!: (error: Error) => void
  ;(sendManualMessageToConversation as jest.Mock).mockReturnValueOnce(
    new Promise<void>((_resolve, reject) => {
      fail = reject
    })
  )
  const { ta } = renderComposer(boundSession())
  const pastedText = "L1\nL2\nL3\nL4\nL5\nL6"
  fireEvent.paste(ta, { clipboardData: { items: [], getData: () => pastedText } })
  expect(ta.value).toContain("[Pasted")
  fireEvent.keyDown(ta, { key: "Enter" })
  await waitFor(() => expect(sendManualMessageToConversation).toHaveBeenCalled())
  fireEvent.change(ta, { target: { value: "New draft" } })
  await act(async () => fail(new Error("offline")))
  expect(ta.value).toBe("New draft")
  ta.setSelectionRange(0, 0)
  fireEvent.keyDown(ta, { key: "ArrowUp" })
  expect(ta.value).toBe(pastedText)
  await waitFor(async () => expect(await listInputHistory("ses_behavior")).toContain(pastedText))
})

it.each([false, true])(
  "consumes only the submitted reply target (changed: %s)",
  async (changed) => {
    let complete!: () => void
    ;(sendManualMessageToConversation as jest.Mock).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        complete = resolve
      })
    )
    const session = boundSession()
    const submittedReply = { messageId: "original", preview: "Original" }
    const nextReply = { messageId: "next", preview: "Next" }
    useChatStore.getState().setReplyTo(submittedReply, session.id)
    const { ta } = renderComposer(session)
    fireEvent.change(ta, { target: { value: "Reply" } })
    fireEvent.keyDown(ta, { key: "Enter" })
    await waitFor(() => expect(sendManualMessageToConversation).toHaveBeenCalled())
    expect(sendManualMessageToConversation).toHaveBeenCalledWith(
      expect.objectContaining({ replyTo: submittedReply })
    )
    if (changed) act(() => useChatStore.getState().setReplyTo(nextReply, session.id))
    await act(async () => complete())
    expect(selectComposerReplyTo(useChatStore.getState(), session.id)).toEqual(
      changed ? nextReply : null
    )
  }
)

it.each([
  [false, "New draft"],
  [true, "New draft"],
  [true, ""],
])(
  "keeps the current draft after a failed send (session changed: %s, text: %s)",
  async (changed, nextText) => {
    let fail!: (error: Error) => void
    ;(sendManualMessageToConversation as jest.Mock).mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        fail = reject
      })
    )
    const { ta, onSend, switchSession } = renderComposer(boundSession())
    const submittedText = "/clear\nSubmitted reply"
    fireEvent.change(ta, { target: { value: submittedText } })
    fireEvent.keyDown(ta, { key: "Enter" })
    await waitFor(() => expect(sendManualMessageToConversation).toHaveBeenCalled())
    if (changed) switchSession({ ...boundSession(), id: "another-session" })
    fireEvent.change(ta, { target: { value: nextText } })

    await act(async () => fail(new Error("offline")))

    expect(ta.value).toBe(nextText)
    expect(onSend).not.toHaveBeenCalled()
    expect(sendManualMessageToConversation).toHaveBeenCalledWith(
      expect.objectContaining({ text: submittedText })
    )
    await waitFor(async () => {
      expect(await listInputHistory("ses_behavior")).toContain(submittedText)
    })
    if (!changed) {
      ta.setSelectionRange(0, 0)
      fireEvent.keyDown(ta, { key: "ArrowUp" })
      expect(ta.value).toBe(submittedText)
      fireEvent.keyDown(ta, { key: "ArrowDown" })
      expect(ta.value).toBe(nextText)
    }
  }
)

it.each(["auto", "draft", "manual"])(
  "primary send always sends to the platform in %s mode",
  async (mode) => {
    await getDb().conversationOverrides.put({
      id: "override",
      conversationKey: "telegram:bot:chat",
      modeOverride: mode,
      updatedAt: Date.now(),
    } as never)
    ;(sendManualMessageToConversation as jest.Mock).mockResolvedValue({ route: "remote" })
    const { ta, onSend } = renderComposer(boundSession())
    fireEvent.change(ta, { target: { value: "Human reply" } })
    fireEvent.keyDown(ta, { key: "Enter" })
    await waitFor(() =>
      expect(sendManualMessageToConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Human reply",
          session: expect.objectContaining({ id: "ses_behavior" }),
        })
      )
    )
    expect(onSend).not.toHaveBeenCalled()
    await waitFor(() => expect(ta.value).toBe(""))
  }
)

it("keeps input when platform sending fails", async () => {
  ;(sendManualMessageToConversation as jest.Mock).mockRejectedValueOnce(new Error("offline"))
  const { ta, onSend } = renderComposer(boundSession())
  fireEvent.change(ta, { target: { value: "Keep this reply" } })
  fireEvent.keyDown(ta, { key: "Enter" })
  await waitFor(() => expect(sendManualMessageToConversation).toHaveBeenCalled())
  await waitFor(() => expect(ta.value).toBe("Keep this reply"))
  expect(onSend).not.toHaveBeenCalled()
})

// A bound conversation forwards files to a person as they are: no video
// sampling, so the picker does not offer videos in the first place.
it("does not offer videos in a platform conversation's file picker", () => {
  renderComposer(boundSession())
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  expect(input.accept).toContain("image/*")
  expect(input.accept).not.toContain("video/*")
})

it("explains unsupported platform attachments and preserves the input", async () => {
  ;(sendManualMessageToConversation as jest.Mock).mockRejectedValueOnce(
    new UnsupportedPlatformAttachmentsError("telegram")
  )
  const { ta } = renderComposer(boundSession())
  fireEvent.change(ta, { target: { value: "Keep this reply" } })
  fireEvent.keyDown(ta, { key: "Enter" })
  await waitFor(() => expect(ta.value).toBe("Keep this reply"))
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Telegram"))
  expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/attachment/i))
})

it("offers a send button on a remote route and a separate draft-review action", async () => {
  const { ta } = renderComposer(boundSession())
  fireEvent.change(ta, { target: { value: "hello" } })
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Review drafts|reviewDrafts/ })).toBeInTheDocument()
  )
})

// The primary button's draft mode existed but was hard-wired off; the only way
// in was the small "Review drafts" link above the box.
it("turns the empty send button into the draft review, and gives it back on typing", async () => {
  const { listPendingForConversation } = jest.requireMock("@/lib/db/connector-drafts") as {
    listPendingForConversation: jest.Mock
  }
  listPendingForConversation.mockResolvedValue([
    { id: "d1", conversationKey: "c1", content: "Drafted reply", status: "pending" },
  ])
  try {
    const { ta } = renderComposer(boundSession())
    const review = await screen.findByTestId("composer-review-drafts")
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull()
    fireEvent.click(review)
    expect(await screen.findByTestId("draft-editor-d1")).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("draft-editor-d1")).toBeNull())

    fireEvent.change(ta, { target: { value: "my own reply" } })
    expect(screen.queryByTestId("composer-review-drafts")).toBeNull()
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
  } finally {
    listPendingForConversation.mockResolvedValue([])
  }
})

it.each(["/clear", "!echo hello", "#remember this", "/local explain this"])(
  "sends %s literally instead of invoking local commands",
  async (text) => {
    ;(sendManualMessageToConversation as jest.Mock).mockResolvedValueOnce({ route: "remote" })
    const { ta, onSend } = renderComposer(boundSession())
    fireEvent.change(ta, { target: { value: text, selectionStart: text.length } })
    fireEvent.keyDown(ta, { key: "Enter" })
    await waitFor(() =>
      expect(sendManualMessageToConversation).toHaveBeenCalledWith(
        expect.objectContaining({ text })
      )
    )
    expect(onSend).not.toHaveBeenCalled()
  }
)
