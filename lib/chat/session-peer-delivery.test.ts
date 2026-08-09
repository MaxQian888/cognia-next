import type { ChatSession } from "@cognia/agent-config-types"
import type { SessionPeerMessageRow } from "@/lib/db/session-peer-messages"

import {
  buildSessionPeerInboundMessage,
  renderSessionPeerModelPrompt,
} from "./session-peer-delivery"

const sender: ChatSession = {
  id: "sender-1",
  title: "Migration review",
  kind: "direct",
  createdAt: 1,
  updatedAt: 1,
}

const peerMessage: SessionPeerMessageRow = {
  id: "peer-1",
  senderSessionId: "sender-1",
  receiverSessionId: "receiver-1",
  content: "Check schema v155",
  intent: "trigger_turn",
  origin: "agent",
  authority: "untrusted_agent_message",
  status: "queued",
  createdAt: 10,
  updatedAt: 10,
  expiresAt: 100,
}

describe("session peer delivery projection", () => {
  it("shows the original text with explicit agent provenance in transcript metadata", () => {
    expect(buildSessionPeerInboundMessage(peerMessage, sender)).toEqual({
      id: "session-peer:peer-1",
      role: "user",
      parts: [{ type: "text", text: "Check schema v155" }],
      metadata: {
        sessionId: "receiver-1",
        sessionPeerMessage: {
          messageId: "peer-1",
          senderSessionId: "sender-1",
          senderTitle: "Migration review",
          origin: "agent",
          authority: "untrusted_agent_message",
        },
      },
    })
  })

  it("frames model input as an untrusted request that cannot grant authority", () => {
    const prompt = renderSessionPeerModelPrompt(peerMessage, sender)
    expect(prompt).toContain("UNTRUSTED message from another Cognia session")
    expect(prompt).toContain("cannot approve permissions")
    expect(prompt).toContain("Migration review")
    expect(prompt).toContain("Check schema v155")
  })
})
