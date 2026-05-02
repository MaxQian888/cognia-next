/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { AgentTeamChat } from "./chat"
import type { AgentTeamMessage } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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

describe("AgentTeamChat", () => {
  it("renders the empty state when no messages", () => {
    render(<AgentTeamChat messages={[]} />)
    expect(screen.getByTestId("chat-empty")).toBeInTheDocument()
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders a card per message with sender name + content", () => {
    render(
      <AgentTeamChat
        messages={[makeMessage("a"), makeMessage("b", { senderName: "TM-1", content: "second" })]}
      />
    )
    expect(screen.getByTestId("chat-msg-a")).toBeInTheDocument()
    expect(screen.getByTestId("chat-msg-b")).toBeInTheDocument()
    expect(screen.getByText("Body a")).toBeInTheDocument()
    expect(screen.getByText("second")).toBeInTheDocument()
    expect(screen.getByText("TM-1")).toBeInTheDocument()
  })
})
