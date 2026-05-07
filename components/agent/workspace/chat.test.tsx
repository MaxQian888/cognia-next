/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { AgentTeamChat } from "./chat"
import type { AgentTeamMessage } from "@/types/agent/agent-team"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock TeamComposer + TeamMentionChips so we don't pull in the heavy real
// composer; we still verify wiring (props received, callbacks invoked).
jest.mock("./team-composer", () => {
  const React = jest.requireActual("react") as typeof import("react")
  return {
    TeamComposer: React.forwardRef<unknown, Record<string, unknown>>(
      function MockTeamComposer(props, _ref) {
        return (
          <div
            data-testid="mock-team-composer"
            data-disabled={String(Boolean(props.disabled))}
            data-streaming={String(Boolean(props.isStreaming))}
            data-mentionables={
              Array.isArray(props.mentionables) ? (props.mentionables as MentionTarget[]).length : 0
            }
          >
            <button
              data-testid="mock-send"
              type="button"
              onClick={() => (props.onSend as (raw: string) => Promise<void>)("@codex hi")}
            >
              send
            </button>
          </div>
        )
      }
    ),
  }
})

jest.mock("./team-mention-chips", () => ({
  TeamMentionChips: ({
    targets,
    onPick,
  }: {
    targets: MentionTarget[]
    onPick: (t: MentionTarget) => void
  }) => (
    <div data-testid="mock-mention-chips">
      {targets.map((t) => (
        <button key={t.id} data-testid={`mock-chip-${t.id}`} onClick={() => onPick(t)}>
          {t.name}
        </button>
      ))}
    </div>
  ),
}))

// Mock the heavy markdown stack so chat.test.tsx doesn't pull in react-markdown ESM.
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="mock-markdown">{content}</div>
  ),
}))

jest.mock("./tool-call-card", () => ({
  ToolCallList: ({ calls }: { calls: { id: string; name: string }[] }) => (
    <div data-testid="mock-tool-call-list" data-count={calls.length}>
      {calls.map((c) => (
        <span key={c.id}>{c.name}</span>
      ))}
    </div>
  ),
}))

jest.mock("./token-usage-line", () => ({
  TokenUsageLine: ({ usage }: { usage: { totalTokens?: number } }) => (
    <div data-testid="mock-token-usage" data-total={usage.totalTokens ?? 0} />
  ),
}))

jest.mock("./message-actions-menu", () => ({
  MessageActionsMenu: ({ message }: { message: { id: string } }) => (
    <div data-testid={`mock-actions-${message.id}`} />
  ),
}))

function makeMessage(id: string, overrides: Partial<AgentTeamMessage> = {}): AgentTeamMessage {
  return {
    id,
    teamId: "t1",
    type: "broadcast",
    senderId: "lead-1",
    senderName: "Lead Bot",
    content: `Body ${id}`,
    read: false,
    timestamp: new Date(2026, 0, 1),
    ...overrides,
  }
}

const targets: MentionTarget[] = [
  {
    kind: "virtual",
    id: "__virtual_codex__",
    name: "codex",
    runtime: "codex",
    description: "OpenAI Codex",
  },
  {
    kind: "virtual",
    id: "__virtual_claude__",
    name: "claude",
    runtime: "claude",
    description: "Anthropic",
  },
]

describe("AgentTeamChat", () => {
  it("renders the empty state when no messages and no composer", () => {
    render(<AgentTeamChat teamId="t1" messages={[]} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
    expect(screen.queryByTestId("mock-team-composer")).toBeNull()
  })

  it("renders a card per message with sender name + content", () => {
    render(
      <AgentTeamChat
        teamId="t1"
        messages={[makeMessage("a"), makeMessage("b", { senderName: "TM-1", content: "second" })]}
      />
    )
    expect(screen.getByTestId("chat-msg-a")).toBeInTheDocument()
    expect(screen.getByTestId("chat-msg-b")).toBeInTheDocument()
    expect(screen.getByText("Body a")).toBeInTheDocument()
    expect(screen.getByText("second")).toBeInTheDocument()
    expect(screen.getByText("TM-1")).toBeInTheDocument()
  })

  it("renders the composer + chips when mentionables and onSend are provided", () => {
    const onSend = jest.fn()
    render(
      <AgentTeamChat
        teamId="t1"
        messages={[makeMessage("a")]}
        mentionables={targets}
        onSend={onSend}
      />
    )
    expect(screen.getByTestId("mock-team-composer")).toBeInTheDocument()
    expect(screen.getByTestId("mock-mention-chips")).toBeInTheDocument()
    expect(screen.getByTestId("mock-chip-__virtual_codex__")).toBeInTheDocument()
  })

  it("forwards the onSend callback through to the composer", () => {
    const onSend = jest.fn()
    render(<AgentTeamChat teamId="t1" messages={[]} mentionables={targets} onSend={onSend} />)
    fireEvent.click(screen.getByTestId("mock-send"))
    expect(onSend).toHaveBeenCalledWith("@codex hi")
  })

  it("flags the composer as streaming when isSending is true", () => {
    render(
      <AgentTeamChat
        teamId="t1"
        messages={[]}
        mentionables={targets}
        onSend={jest.fn()}
        isSending
      />
    )
    // The textarea stays interactive (not disabled) so the user can queue a
    // follow-up; the streaming flag is what surfaces the stop button banner.
    const composer = screen.getByTestId("mock-team-composer")
    expect(composer).toHaveAttribute("data-streaming", "true")
    expect(composer).toHaveAttribute("data-disabled", "false")
  })

  it("flags streaming messages with the streaming attribute", () => {
    const streamingMsg = makeMessage("s1", {
      content: "...",
      metadata: { streaming: true },
    })
    render(<AgentTeamChat teamId="t1" messages={[streamingMsg]} />)
    expect(screen.getByTestId("chat-msg-s1")).toHaveAttribute("data-streaming", "true")
  })

  it("renders ToolCallList when message metadata carries toolCalls", () => {
    const msg = makeMessage("tc", {
      metadata: {
        toolCalls: [
          { id: "x", name: "ls", status: "complete", output: "a" },
          { id: "y", name: "cat", status: "running" },
        ],
      },
    })
    render(<AgentTeamChat teamId="t1" messages={[msg]} />)
    const list = screen.getByTestId("mock-tool-call-list")
    expect(list).toHaveAttribute("data-count", "2")
  })

  it("renders TokenUsageLine when metadata carries tokenUsage", () => {
    const msg = makeMessage("tu", {
      metadata: {
        tokenUsage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
      },
    })
    render(<AgentTeamChat teamId="t1" messages={[msg]} />)
    expect(screen.getByTestId("mock-token-usage")).toHaveAttribute("data-total", "12")
  })

  it("renders MessageActionsMenu when onRetry or onDelete is provided", () => {
    const msg = makeMessage("ma")
    render(<AgentTeamChat teamId="t1" messages={[msg]} onDelete={jest.fn()} />)
    expect(screen.getByTestId("mock-actions-ma")).toBeInTheDocument()
  })

  it("hides MessageActionsMenu when neither onRetry nor onDelete is provided", () => {
    const msg = makeMessage("ma2")
    render(<AgentTeamChat teamId="t1" messages={[msg]} />)
    expect(screen.queryByTestId("mock-actions-ma2")).toBeNull()
  })

  it("hides MessageActionsMenu while a message is streaming", () => {
    const msg = makeMessage("ma3", {
      content: "...",
      metadata: { streaming: true },
    })
    render(<AgentTeamChat teamId="t1" messages={[msg]} onDelete={jest.fn()} />)
    expect(screen.queryByTestId("mock-actions-ma3")).toBeNull()
  })
})
