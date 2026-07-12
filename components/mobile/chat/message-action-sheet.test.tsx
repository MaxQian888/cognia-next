/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { UIMessage } from "ai"

import { MessageActionSheet, extractPlainText } from "./message-action-sheet"

jest.mock("@/lib/capacitor/share", () => ({
  __esModule: true,
  share: jest.fn(),
}))

jest.mock("sonner", () => ({
  __esModule: true,
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

// Stub the branch dialog: opening it pulls in stores/Dexie we don't need here.
jest.mock("@/components/chat/branch-dialog", () => ({
  __esModule: true,
  BranchDialog: ({ sessionId, messageId }: { sessionId: string; messageId: string }) => (
    <div data-testid="branch-dialog" data-session={sessionId} data-message={messageId} />
  ),
}))

// Importing the composer for the append-event constant would drag in the whole
// composer module (stores, Dexie, etc.); stub it to just the string (mirrors
// plugins/ocr/src/ocr-result-card.test.tsx).
jest.mock("@/components/chat/composer", () => ({
  __esModule: true,
  COMPOSER_APPEND_EVENT: "cognia:composer-append",
}))

jest.mock("@/lib/capacitor/haptics", () => ({
  __esModule: true,
  selectionFeedback: jest.fn(),
  notify: jest.fn(),
}))

// Store hooks: plain selector-callable fakes so the sheet's bookmark / TTS
// gates work without dragging Dexie-backed stores into jsdom.
const chatState = {
  bookmarkedIds: [] as string[],
  toggleBookmark: jest.fn(),
}
jest.mock("@/stores/chat", () => ({
  __esModule: true,
  useChatStore: (selector: (s: typeof chatState) => unknown) => selector(chatState),
}))

const settingsState = { settings: { ttsEnabled: true } }
jest.mock("@/stores/settings", () => ({
  __esModule: true,
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
}))

const readAloudStatus = { isActive: false, isLoading: false }
jest.mock("@/hooks/media/use-read-aloud-status", () => ({
  __esModule: true,
  useReadAloudStatus: () => readAloudStatus,
}))

jest.mock("@/lib/tts/speak-chat-message", () => ({
  __esModule: true,
  speakChatMessage: jest.fn(async () => {}),
}))

jest.mock("@/lib/tts/tts-orchestrator", () => ({
  __esModule: true,
  ttsOrchestrator: { stop: jest.fn() },
}))

// BranchNavigator reads the chat store's live messages; stub it so the
// "variants" wrapper row can be asserted without store plumbing.
jest.mock("@/components/chat/branch-navigator", () => ({
  __esModule: true,
  BranchNavigator: () => <div data-testid="branch-navigator" />,
}))

import { share } from "@/lib/capacitor/share"
import { toast } from "sonner"
import { speakChatMessage } from "@/lib/tts/speak-chat-message"
import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"

const mockShare = share as jest.Mock
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock
const mockSpeak = speakChatMessage as jest.Mock
const mockTtsStop = ttsOrchestrator.stop as jest.Mock

const messages = {
  mobile: {
    messageActions: {
      title: "Message",
      description: "Pick an action.",
      copy: "Copy text",
      copySuccess: "Copied to clipboard.",
      copyFailed: "Copy failed: {message}",
      quote: "Quote",
      share: "Share…",
      shareDialogTitle: "Share via",
      shareUnsupported: "Sharing isn't supported on this device.",
      shareFailed: "Share failed: {message}",
      branch: "Branch conversation",
      regenerate: "Regenerate reply",
      delete: "Delete message",
      deleteConfirmTitle: "Delete this message?",
      deleteConfirmDescription: "Removes it everywhere.",
      deleteConfirm: "Delete",
      deleteSuccess: "Message deleted.",
      deleteFailed: "Delete failed: {message}",
      edit: "Edit & resend",
      editFailed: "Resend failed: {message}",
      editInputAria: "Edit message text",
      editResend: "Resend",
      bookmark: "Bookmark",
      bookmarkRemove: "Remove bookmark",
      branchVariants: "Reply variants",
      readAloud: "Read aloud",
      stopReading: "Stop reading",
    },
  },
  common: { cancel: "Cancel" },
}

function renderSheet(
  message: UIMessage | null,
  onOpenChange: jest.Mock,
  extra: {
    onRegenerate?: () => void | Promise<void>
    onDelete?: (m: UIMessage) => void | Promise<void>
    onEditResend?: (m: UIMessage, newText: string) => void | Promise<void>
    character?: { voiceProfile?: undefined } | null
  } = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MessageActionSheet message={message} onOpenChange={onOpenChange} {...extra} />
    </NextIntlClientProvider>
  )
}

function makeMessage(text: string): UIMessage {
  return {
    id: "m1",
    role: "assistant",
    parts: [{ type: "text", text }],
  } as UIMessage
}

describe("extractPlainText", () => {
  it("joins text parts with newlines", () => {
    const msg = {
      id: "x",
      role: "user",
      parts: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    } as UIMessage
    expect(extractPlainText(msg)).toBe("first\nsecond")
  })

  it("includes reasoning parts", () => {
    const msg = {
      id: "x",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "answer" },
      ],
    } as UIMessage
    expect(extractPlainText(msg)).toBe("thinking\nanswer")
  })

  it("skips tool and file parts", () => {
    const msg = {
      id: "x",
      role: "assistant",
      parts: [
        { type: "tool-search", input: {} },
        { type: "file", url: "data:..." },
        { type: "text", text: "hello" },
      ],
    } as UIMessage
    expect(extractPlainText(msg)).toBe("hello")
  })

  it("returns empty string for an empty parts array", () => {
    const msg = { id: "x", role: "assistant", parts: [] } as UIMessage
    expect(extractPlainText(msg)).toBe("")
  })
})

describe("MessageActionSheet", () => {
  beforeEach(() => {
    mockShare.mockReset()
    mockToastSuccess.mockReset()
    mockToastError.mockReset()
    mockSpeak.mockClear()
    mockTtsStop.mockClear()
    chatState.toggleBookmark.mockClear()
    chatState.bookmarkedIds = []
    settingsState.settings.ttsEnabled = true
    readAloudStatus.isActive = false
    readAloudStatus.isLoading = false
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    })
  })

  it("does not render content when message is null", () => {
    const onOpenChange = jest.fn()
    renderSheet(null, onOpenChange)
    expect(screen.queryByTestId("message-action-sheet")).not.toBeInTheDocument()
  })

  it("renders Copy and Share rows when a message is provided", () => {
    renderSheet(makeMessage("hello"), jest.fn())
    expect(screen.getByTestId("message-action-copy")).toBeInTheDocument()
    expect(screen.getByTestId("message-action-share")).toBeInTheDocument()
  })

  it("shows a per-message usage footer for assistant messages with usage metadata", () => {
    const msg = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
      metadata: { usage: { inputTokens: 12, outputTokens: 34, totalCostUsd: 0.005 } },
    } as unknown as UIMessage
    renderSheet(msg, jest.fn())
    const usage = screen.getByTestId("message-action-usage")
    expect(usage).toHaveTextContent("12")
    expect(usage).toHaveTextContent("34")
  })

  it("omits the usage footer when the message carries no usage metadata", () => {
    renderSheet(makeMessage("plain"), jest.fn())
    expect(screen.queryByTestId("message-action-usage")).toBeNull()
  })

  it("hides the Branch row without a session id", () => {
    renderSheet(makeMessage("hello"), jest.fn())
    expect(screen.queryByTestId("message-action-branch")).not.toBeInTheDocument()
  })

  it("shows the Branch row and opens the dialog when a session id is present", () => {
    const msg = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
      metadata: { sessionId: "s9" },
    } as UIMessage
    const onOpenChange = jest.fn()
    renderSheet(msg, onOpenChange)
    fireEvent.click(screen.getByTestId("message-action-branch"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    const dialog = screen.getByTestId("branch-dialog")
    expect(dialog).toHaveAttribute("data-session", "s9")
    expect(dialog).toHaveAttribute("data-message", "m1")
  })

  it("calls clipboard.writeText and closes on Copy", async () => {
    const onOpenChange = jest.fn()
    renderSheet(makeMessage("hello world"), onOpenChange)
    fireEvent.click(screen.getByTestId("message-action-copy"))
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello world")
    })
    expect(mockToastSuccess).toHaveBeenCalledWith("Copied to clipboard.")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("hides Regenerate and Delete rows when handlers are absent", () => {
    renderSheet(makeMessage("hello"), jest.fn())
    expect(screen.queryByTestId("message-action-regenerate")).not.toBeInTheDocument()
    expect(screen.queryByTestId("message-action-delete")).not.toBeInTheDocument()
  })

  it("runs onRegenerate and closes on the Regenerate row", () => {
    const onOpenChange = jest.fn()
    const onRegenerate = jest.fn()
    renderSheet(makeMessage("hello"), onOpenChange, { onRegenerate })
    fireEvent.click(screen.getByTestId("message-action-regenerate"))
    expect(onRegenerate).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("Delete asks for confirmation before calling onDelete", async () => {
    const onOpenChange = jest.fn()
    const onDelete = jest.fn().mockResolvedValue(undefined)
    const msg = makeMessage("hello")
    renderSheet(msg, onOpenChange, { onDelete })
    fireEvent.click(screen.getByTestId("message-action-delete"))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId("message-action-delete-confirm"))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(msg))
    expect(mockToastSuccess).toHaveBeenCalledWith("Message deleted.")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("surfaces a toast when onDelete rejects", async () => {
    const onDelete = jest.fn().mockRejectedValue(new Error("boom"))
    renderSheet(makeMessage("hello"), jest.fn(), { onDelete })
    fireEvent.click(screen.getByTestId("message-action-delete"))
    fireEvent.click(await screen.findByTestId("message-action-delete-confirm"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Delete failed: boom"))
  })

  it("renders the Quote row", () => {
    renderSheet(makeMessage("hello"), jest.fn())
    expect(screen.getByTestId("message-action-quote")).toBeInTheDocument()
  })

  it("disables Copy/Quote/Share for an empty message", () => {
    renderSheet(makeMessage(""), jest.fn())
    expect(screen.getByTestId("message-action-quote")).toBeDisabled()
    expect(screen.getByTestId("message-action-copy")).toBeDisabled()
    expect(screen.getByTestId("message-action-share")).toBeDisabled()
  })

  it("dispatches a markdown blockquote to the composer and closes on Quote", () => {
    const onOpenChange = jest.fn()
    const handler = jest.fn()
    window.addEventListener("cognia:composer-append", handler)
    renderSheet(makeMessage("line one\nline two"), onOpenChange)
    fireEvent.click(screen.getByTestId("message-action-quote"))
    window.removeEventListener("cognia:composer-append", handler)
    expect(handler).toHaveBeenCalledTimes(1)
    const detail = (handler.mock.calls[0][0] as CustomEvent<{ text: string }>).detail
    expect(detail.text).toBe("> line one\n> line two\n\n")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("invokes share and closes on shared outcome", async () => {
    mockShare.mockResolvedValue({ kind: "shared" })
    const onOpenChange = jest.fn()
    renderSheet(makeMessage("greetings"), onOpenChange)
    fireEvent.click(screen.getByTestId("message-action-share"))
    await waitFor(() => {
      expect(mockShare).toHaveBeenCalledWith({
        text: "greetings",
        dialogTitle: "Share via",
      })
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("toasts on share unsupported", async () => {
    mockShare.mockResolvedValue({ kind: "unsupported" })
    renderSheet(makeMessage("greetings"), jest.fn())
    fireEvent.click(screen.getByTestId("message-action-share"))
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Sharing isn't supported on this device.")
    })
  })

  it("does not toast on cancelled share", async () => {
    mockShare.mockResolvedValue({ kind: "cancelled" })
    renderSheet(makeMessage("greetings"), jest.fn())
    fireEvent.click(screen.getByTestId("message-action-share"))
    await waitFor(() => {
      expect(mockShare).toHaveBeenCalled()
    })
    expect(mockToastError).not.toHaveBeenCalled()
    expect(mockToastSuccess).not.toHaveBeenCalled()
  })

  it("hides the edit row when onEditResend is not provided", () => {
    renderSheet(makeMessage("hello"), jest.fn())
    expect(screen.queryByTestId("message-action-edit")).not.toBeInTheDocument()
  })

  it("opens the edit pane prefilled with the message text", () => {
    renderSheet(makeMessage("original text"), jest.fn(), { onEditResend: jest.fn() })
    fireEvent.click(screen.getByTestId("message-action-edit"))
    const input = screen.getByTestId("message-action-edit-input") as HTMLTextAreaElement
    expect(input.value).toBe("original text")
    // Action list is replaced by the edit pane.
    expect(screen.queryByTestId("message-action-copy")).not.toBeInTheDocument()
  })

  it("resends the trimmed edited text and closes the sheet", async () => {
    const onEditResend = jest.fn().mockResolvedValue(undefined)
    const onOpenChange = jest.fn()
    const message = makeMessage("original text")
    renderSheet(message, onOpenChange, { onEditResend })

    fireEvent.click(screen.getByTestId("message-action-edit"))
    fireEvent.change(screen.getByTestId("message-action-edit-input"), {
      target: { value: "  fixed question  " },
    })
    fireEvent.click(screen.getByTestId("message-action-edit-send"))

    await waitFor(() => {
      expect(onEditResend).toHaveBeenCalledWith(message, "fixed question")
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("disables resend when the edited text is blank", () => {
    renderSheet(makeMessage("original"), jest.fn(), { onEditResend: jest.fn() })
    fireEvent.click(screen.getByTestId("message-action-edit"))
    fireEvent.change(screen.getByTestId("message-action-edit-input"), {
      target: { value: "   " },
    })
    expect(screen.getByTestId("message-action-edit-send")).toBeDisabled()
  })

  it("cancel returns to the action list without resending", () => {
    const onEditResend = jest.fn()
    renderSheet(makeMessage("original"), jest.fn(), { onEditResend })
    fireEvent.click(screen.getByTestId("message-action-edit"))
    fireEvent.click(screen.getByTestId("message-action-edit-cancel"))
    expect(screen.getByTestId("message-action-copy")).toBeInTheDocument()
    expect(onEditResend).not.toHaveBeenCalled()
  })

  it("toggles the bookmark and closes on the Bookmark row", () => {
    const onOpenChange = jest.fn()
    renderSheet(makeMessage("hello"), onOpenChange)
    fireEvent.click(screen.getByTestId("message-action-bookmark"))
    expect(chatState.toggleBookmark).toHaveBeenCalledWith("m1")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("labels the Bookmark row as removal when the message is already bookmarked", () => {
    chatState.bookmarkedIds = ["m1"]
    renderSheet(makeMessage("hello"), jest.fn())
    expect(screen.getByTestId("message-action-bookmark")).toHaveTextContent("Remove bookmark")
  })

  it("starts read-aloud with the message text + character and closes", () => {
    const onOpenChange = jest.fn()
    const character = { voiceProfile: undefined }
    renderSheet(makeMessage("say this"), onOpenChange, { character })
    fireEvent.click(screen.getByTestId("message-action-read-aloud"))
    expect(mockSpeak).toHaveBeenCalledWith({
      messageId: "m1",
      text: "say this",
      character,
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("stops read-aloud when it is already active", () => {
    readAloudStatus.isActive = true
    renderSheet(makeMessage("say this"), jest.fn())
    const row = screen.getByTestId("message-action-read-aloud")
    expect(row).toHaveTextContent("Stop reading")
    fireEvent.click(row)
    expect(mockTtsStop).toHaveBeenCalledTimes(1)
    expect(mockSpeak).not.toHaveBeenCalled()
  })

  it("hides the read-aloud row when TTS is disabled or the message is not assistant", () => {
    settingsState.settings.ttsEnabled = false
    const { unmount } = renderSheet(makeMessage("hello"), jest.fn())
    expect(screen.queryByTestId("message-action-read-aloud")).not.toBeInTheDocument()
    unmount()

    settingsState.settings.ttsEnabled = true
    const userMsg = {
      id: "m2",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    } as UIMessage
    renderSheet(userMsg, jest.fn())
    expect(screen.queryByTestId("message-action-read-aloud")).not.toBeInTheDocument()
  })

  it("hosts the branch-variants navigator row for assistant messages", () => {
    renderSheet(makeMessage("hello"), jest.fn())
    expect(screen.getByTestId("message-action-branch-variants")).toBeInTheDocument()
    expect(screen.getByTestId("branch-navigator")).toBeInTheDocument()
  })

  it("toasts and stays open when the resend fails", async () => {
    const onEditResend = jest.fn().mockRejectedValue(new Error("offline"))
    const onOpenChange = jest.fn()
    renderSheet(makeMessage("original"), onOpenChange, { onEditResend })

    fireEvent.click(screen.getByTestId("message-action-edit"))
    fireEvent.click(screen.getByTestId("message-action-edit-send"))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Resend failed: offline")
    })
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByTestId("message-action-edit-input")).toBeInTheDocument()
  })
})
