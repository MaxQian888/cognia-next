/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

const toast = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toast.success(...a),
    error: (...a: unknown[]) => toast.error(...a),
  },
}))

jest.mock("@cognia/logging", () => ({
  loggers: { chat: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } },
}))

let imConfigured = true
jest.mock("@/hooks/inbox/use-im-configured", () => ({
  useImConfigured: () => imConfigured,
}))

const sendManualTextToConversation = jest.fn()
jest.mock("@/lib/inbox/manual-send", () => ({
  sendManualTextToConversation: (...a: unknown[]) => sendManualTextToConversation(...a),
}))

const startNewSession = jest.fn()
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...a: unknown[]) => startNewSession(...a),
}))

const setActiveSession = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ setActiveSession }) },
}))
const setSelectedGuild = jest.fn()
jest.mock("@/stores/ui", () => ({
  useUIStore: { getState: () => ({ setSelectedGuild }) },
}))
const stage = jest.fn()
jest.mock("@/stores/chat/composer-intent-store", () => ({
  useComposerIntentStore: { getState: () => ({ stage }) },
}))

// The picker is its own suite; here it is a button that picks a fixed target.
let lastPickerProps: Record<string, unknown> | null = null
jest.mock("@/components/inbox/conversation-picker-dialog", () => ({
  ConversationPickerDialog: (props: {
    open: boolean
    onOpenChange: (o: boolean) => void
    onSelect: (s: unknown) => void
    excludeSessionId?: string
  }) => {
    lastPickerProps = props
    return props.open ? (
      <button
        data-testid="picker-pick"
        onClick={() => {
          props.onOpenChange(false)
          props.onSelect(TARGET)
        }}
      >
        pick
      </button>
    ) : null
  },
}))

const TARGET = {
  id: "im1",
  title: "Alice",
  platformBinding: {
    adapterId: "a1",
    platform: "telegram",
    conversationKey: "telegram:a1:1001",
    conversationRef: { platform: "telegram", adapterId: "a1" },
  },
}

import { MessageImActions, hasPlatformMessage, quoteForComposer } from "./message-im-actions"

const plainMessage: UIMessage = { id: "m1", role: "assistant", parts: [{ type: "text", text: "Hi" }] }
const inboundMessage = {
  id: "m2",
  role: "user",
  parts: [{ type: "text", text: "Need help\nwith billing" }],
  metadata: {
    platformMessage: {
      messageId: "tg-1",
      platform: "telegram",
      adapterId: "a1",
      conversationKey: "telegram:a1:1001",
    },
  },
} as UIMessage

beforeEach(() => {
  jest.clearAllMocks()
  imConfigured = true
  lastPickerProps = null
  sendManualTextToConversation.mockResolvedValue({
    jobId: "j1",
    messageId: "msg1",
    route: "local",
    sessionId: "im1",
    conversationKey: "telegram:a1:1001",
  })
  startNewSession.mockResolvedValue({ id: "fresh" })
})

describe("helpers", () => {
  it("detects an inbound IM message by its platformMessage metadata", () => {
    expect(hasPlatformMessage(inboundMessage)).toBe(true)
    expect(hasPlatformMessage(plainMessage)).toBe(false)
    expect(
      hasPlatformMessage({ ...plainMessage, metadata: { platformMessage: "x" } } as UIMessage)
    ).toBe(false)
  })

  it("quotes every line, matching the row's own quote action", () => {
    expect(quoteForComposer("  a\nb  ")).toBe("> a\n> b\n\n")
  })
})

describe("MessageImActions", () => {
  it("renders nothing without text, or without connectors on a plain message", () => {
    const { container, rerender } = render(
      <MessageImActions message={plainMessage} text="   " sessionId="s1" />
    )
    expect(container).toBeEmptyDOMElement()
    imConfigured = false
    rerender(<MessageImActions message={plainMessage} text="Hi" sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("keeps 'continue in new chat' for an inbound IM message even with no connector configured", () => {
    imConfigured = false
    render(<MessageImActions message={inboundMessage} text="Need help" sessionId="s1" />)
    expect(screen.getByTestId("message-continue-in-new-chat")).toBeInTheDocument()
    expect(screen.queryByTestId("message-send-to-im")).not.toBeInTheDocument()
  })

  it("offers 'send to IM' on any text message, and 'continue' only for inbound IM ones", () => {
    const { rerender } = render(
      <MessageImActions message={plainMessage} text="Hi" sessionId="s1" />
    )
    expect(screen.getByTestId("message-send-to-im")).toBeInTheDocument()
    expect(screen.queryByTestId("message-continue-in-new-chat")).not.toBeInTheDocument()
    rerender(<MessageImActions message={inboundMessage} text="Need help" sessionId="s1" />)
    expect(screen.getByTestId("message-continue-in-new-chat")).toBeInTheDocument()
  })

  it("opens the picker (excluding the current session), sends the text, and toasts a link", async () => {
    render(<MessageImActions message={plainMessage} text="  Hi there  " sessionId="s1" />)
    expect(lastPickerProps).toBeNull()
    fireEvent.click(screen.getByTestId("message-send-to-im"))
    expect(lastPickerProps).toMatchObject({ open: true, excludeSessionId: "s1" })
    fireEvent.click(screen.getByTestId("picker-pick"))
    await waitFor(() => expect(sendManualTextToConversation).toHaveBeenCalled())
    expect(sendManualTextToConversation).toHaveBeenCalledWith({ session: TARGET, text: "Hi there" })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const [title, opts] = toast.success.mock.calls[0]! as [
      string,
      { description: string; action: { label: string; onClick: () => void } },
    ]
    expect(title).toBe("Sent to the IM conversation.")
    expect(opts.description).toBe("Alice")
    expect(opts.action.label).toBe("Open in Inbox")
    opts.action.onClick()
    expect(push).toHaveBeenCalledWith("/inbox/c?key=telegram%3Aa1%3A1001")
    // The picker unmounts once closed.
    expect(screen.queryByTestId("picker-pick")).not.toBeInTheDocument()
  })

  it("surfaces a failed send", async () => {
    sendManualTextToConversation.mockRejectedValueOnce(new Error("relay down"))
    render(<MessageImActions message={plainMessage} text="Hi" />)
    fireEvent.click(screen.getByTestId("message-send-to-im"))
    fireEvent.click(screen.getByTestId("picker-pick"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.error).toHaveBeenCalledWith("Couldn't send to the IM conversation.", {
      description: "relay down",
    })
    expect(lastPickerProps).toMatchObject({ excludeSessionId: undefined })
  })

  it("continues in a new chat: fresh session, DM guild, quoted prompt staged, then home", async () => {
    render(<MessageImActions message={inboundMessage} text={"Need help\nwith billing"} />)
    fireEvent.click(screen.getByTestId("message-continue-in-new-chat"))
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"))
    expect(startNewSession).toHaveBeenCalledWith()
    expect(setActiveSession).toHaveBeenCalledWith("fresh")
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
    expect(stage).toHaveBeenCalledWith("fresh", {
      candidateId: "im-continue:m2",
      prompt: "> Need help\n> with billing\n\n",
    })
    // Staged, not sent — the operator adds their question first.
    expect(stage.mock.calls[0]![1]).not.toHaveProperty("autoSend")
  })

  it("reports a failure to start the new chat", async () => {
    startNewSession.mockRejectedValueOnce(new Error("no db"))
    render(<MessageImActions message={inboundMessage} text="x" />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("message-continue-in-new-chat"))
    })
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("no db"))
    expect(push).not.toHaveBeenCalled()
  })
})
