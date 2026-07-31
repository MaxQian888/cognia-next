/** @jest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { UIMessage } from "ai"
import { TruncateFromDialog, countFromMessage } from "./truncate-from-dialog"
import { useChatStore } from "@/stores/chat/chat-store"

const mockTruncate = jest.fn(async () => undefined)
jest.mock("@/lib/db/messages", () => ({
  truncateAfter: (...args: unknown[]) => mockTruncate(...(args as [])),
}))

const mockMirror = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/chat/mirror-truncate", () => ({
  mirrorTruncateToDesktop: (...args: unknown[]) => mockMirror(...args),
}))

const mockPlatform = jest.fn(() => "tauri")
jest.mock("@/hooks/use-platform", () => ({
  detectPlatform: () => mockPlatform(),
}))

const mockToastSuccess = jest.fn()
const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...(a as [])),
    error: (...a: unknown[]) => mockToastError(...(a as [])),
  },
}))

const messages = {
  chat: {
    truncateFrom: {
      title: "Delete from this message on?",
      description: "{count} will go.",
      cancel: "Keep them",
      confirm: "Delete permanently",
      done: "Deleted {count}.",
      error: "Couldn't delete those messages.",
    },
  },
}

const msg = (id: string): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", text: id }] }) as unknown as UIMessage

function renderDialog(sessionId = "s1", messageId = "m2") {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TruncateFromDialog
        sessionId={sessionId}
        messageId={messageId}
        open
        onOpenChange={jest.fn()}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPlatform.mockReturnValue("tauri")
  useChatStore.setState({
    activeSessionId: "other",
    messages: [msg("zzz")],
    activeBranchByGroup: {},
    sessions: {
      s1: {
        ...useChatStore.getState().sessions.s1,
        messages: [msg("m1"), msg("m2"), msg("m3"), msg("m4")],
        activeBranchByGroup: {},
      },
    } as never,
  })
})

describe("countFromMessage", () => {
  it("counts the cut-off message and everything after it", () => {
    expect(countFromMessage([msg("a"), msg("b"), msg("c")], "b")).toBe(2)
    expect(countFromMessage([msg("a"), msg("b")], "a")).toBe(2)
  })

  it("returns 0 when the message is not in the thread", () => {
    expect(countFromMessage([msg("a")], "nope")).toBe(0)
  })
})

describe("TruncateFromDialog", () => {
  it("counts from the TARGET session's thread, not the focused one", () => {
    // Reachable from a split pane or a sidechat, where the top-level projection
    // is a different conversation entirely — which holds ONE message here, so a
    // count of 3 can only have come from the target session's own thread.
    renderDialog()
    expect(screen.getByText(/These 3 messages will be permanently deleted/)).toBeInTheDocument()
  })

  it("truncates inclusively and asks the pane to re-read from Dexie", async () => {
    const reload = jest.fn()
    useChatStore.setState({ requestSessionMessagesReload: reload } as never)
    renderDialog()
    fireEvent.click(screen.getByText("Delete permanently"))

    await waitFor(() => expect(mockTruncate).toHaveBeenCalledWith("s1", "m2", { inclusive: true }))
    // Re-read rather than splice: hidden branch siblings and their owned
    // subtrees go with the same key range, and rebuilding that set in memory
    // would be a second, divergent implementation.
    await waitFor(() => expect(reload).toHaveBeenCalledWith("s1"))
    expect(mockToastSuccess).toHaveBeenCalled()
  })

  it("mirrors the delete to the paired desktop before truncating on mobile", async () => {
    // Without this the phone deletes only its own rows: the host keeps the
    // messages and the next sync pulls them straight back, so the one
    // deliberately destructive action in the app silently does nothing.
    mockPlatform.mockReturnValue("mobile")
    const order: string[] = []
    mockMirror.mockImplementation(async () => {
      order.push("mirror")
      return undefined
    })
    mockTruncate.mockImplementation(async () => {
      order.push("truncate")
      return undefined
    })
    renderDialog()
    fireEvent.click(screen.getByText("Delete permanently"))

    await waitFor(() => expect(mockMirror).toHaveBeenCalledWith("s1", "m2"))
    // Mirror first: it reads the local rows to work out which ids to delete
    // remotely, so truncating first would leave it nothing to enumerate.
    expect(order).toEqual(["mirror", "truncate"])
  })

  it("does not mirror on the desktop, which owns the store already", async () => {
    renderDialog()
    fireEvent.click(screen.getByText("Delete permanently"))

    await waitFor(() => expect(mockTruncate).toHaveBeenCalled())
    expect(mockMirror).not.toHaveBeenCalled()
  })

  it("surfaces a toast and keeps the dialog open when the delete fails", async () => {
    mockTruncate.mockRejectedValueOnce(new Error("boom"))
    const onOpenChange = jest.fn()
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TruncateFromDialog sessionId="s1" messageId="m2" open onOpenChange={onOpenChange} />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByText("Delete permanently"))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
