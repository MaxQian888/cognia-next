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
}))

import { share } from "@/lib/capacitor/share"
import { toast } from "sonner"

const mockShare = share as jest.Mock
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock

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
    },
  },
}

function renderSheet(message: UIMessage | null, onOpenChange: jest.Mock) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MessageActionSheet message={message} onOpenChange={onOpenChange} />
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
})
