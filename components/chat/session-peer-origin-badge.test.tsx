/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import { SessionPeerOriginBadge } from "./session-peer-origin-badge"

describe("SessionPeerOriginBadge", () => {
  it("labels agent-origin messages as untrusted and names the sender", () => {
    render(
      <SessionPeerOriginBadge
        metadata={{
          sessionPeerMessage: {
            messageId: "peer-1",
            senderSessionId: "sender-1",
            senderTitle: "Migration review",
            origin: "agent",
            authority: "untrusted_agent_message",
          },
        }}
      />
    )
    expect(screen.getByText("Agent message from Migration review · untrusted")).toBeInTheDocument()
  })

  it("renders nothing for an ordinary user message", () => {
    const { container } = render(<SessionPeerOriginBadge metadata={{}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
