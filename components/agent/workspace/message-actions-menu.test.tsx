import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MessageActionsMenu } from "./message-actions-menu"
import type { AgentTeamMessage } from "@/types/agent/agent-team"
import { TEAM_USER_SENDER_ID } from "@/types/agent/agent-team"
import { TEAM_MESSAGE_METADATA_KEYS } from "@/lib/agent-team/team-runtime-dispatcher"

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

function makeMessage(over: Partial<AgentTeamMessage> = {}): AgentTeamMessage {
  return {
    id: "m1",
    teamId: "t",
    type: "direct",
    senderId: "agent-1",
    senderName: "Codex",
    content: "Hello world",
    read: false,
    timestamp: new Date(),
    metadata: {
      [TEAM_MESSAGE_METADATA_KEYS.DISPATCH_TARGET_ID]: "agent-1",
      [TEAM_MESSAGE_METADATA_KEYS.DISPATCH_PROMPT]: "say hi",
    },
    ...over,
  }
}

describe("MessageActionsMenu", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
    })
  })

  it("opens the dropdown and copies the message content", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    const msg = makeMessage()
    render(<MessageActionsMenu message={msg} onDelete={jest.fn()} />)

    await user.click(screen.getByTestId(`msg-actions-trigger-${msg.id}`))
    const copyBtn = await screen.findByTestId(`msg-action-copy-${msg.id}`)
    await user.click(copyBtn)

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("Hello world")
    })
  })

  it("invokes onRetry with stored target + prompt for assistant messages", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onRetry = jest.fn()
    const msg = makeMessage()
    render(<MessageActionsMenu message={msg} onRetry={onRetry} />)

    await user.click(screen.getByTestId(`msg-actions-trigger-${msg.id}`))
    const retry = await screen.findByTestId(`msg-action-retry-${msg.id}`)
    await user.click(retry)
    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledWith({
        targetId: "agent-1",
        prompt: "say hi",
        messageId: "m1",
      })
    })
  })

  it("hides retry for user-sent messages", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onRetry = jest.fn()
    const msg = makeMessage({ senderId: TEAM_USER_SENDER_ID, senderName: "You" })
    render(<MessageActionsMenu message={msg} onRetry={onRetry} />)
    await user.click(screen.getByTestId(`msg-actions-trigger-${msg.id}`))
    expect(screen.queryByTestId(`msg-action-retry-${msg.id}`)).toBeNull()
  })

  it("hides retry when dispatch target metadata is missing", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const msg = makeMessage({ metadata: {} })
    render(<MessageActionsMenu message={msg} onRetry={jest.fn()} />)
    await user.click(screen.getByTestId(`msg-actions-trigger-${msg.id}`))
    expect(screen.queryByTestId(`msg-action-retry-${msg.id}`)).toBeNull()
  })

  it("invokes onDelete with the message id", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onDelete = jest.fn()
    const msg = makeMessage()
    render(<MessageActionsMenu message={msg} onDelete={onDelete} />)
    await user.click(screen.getByTestId(`msg-actions-trigger-${msg.id}`))
    const del = await screen.findByTestId(`msg-action-delete-${msg.id}`)
    await user.click(del)
    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith("m1")
    })
  })

  it("hides delete when onDelete is not supplied", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const msg = makeMessage()
    render(<MessageActionsMenu message={msg} />)
    await user.click(screen.getByTestId(`msg-actions-trigger-${msg.id}`))
    expect(screen.queryByTestId(`msg-action-delete-${msg.id}`)).toBeNull()
  })
})
