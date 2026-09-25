import type { ChatSession } from "@cognia/agent-config-types"

import type { AttentionItem } from "@/lib/attention/types"
import type { FleetSession } from "@/lib/fleet/types"
import { chatStatusOf, conversationCandidates, conversationFacts } from "./conversations"

function fleetSession(agent: FleetSession["agent"], sessionId: string): FleetSession {
  return { agent, sessionId } as FleetSession
}

function chatRow(over: Partial<ChatSession>): ChatSession {
  return { id: "c", title: "", ...over } as ChatSession
}

describe("conversationCandidates", () => {
  it("collects Cognia run sessions and chat approval conversations, sorted and unique", () => {
    const ids = conversationCandidates(
      {
        sessions: [
          fleetSession("cognia", "chat-b"),
          fleetSession("claude-code", "cc-1"),
          fleetSession("cognia", "chat-a"),
          fleetSession("cognia", ""),
        ],
        generatedAt: 0,
      },
      [
        { source: "chat", sessionId: "chat-b" } as AttentionItem,
        { source: "chat", sessionId: "chat-c" } as AttentionItem,
        { source: "run", runId: "r" } as AttentionItem,
        { source: "chat" } as AttentionItem,
      ]
    )
    expect(ids).toEqual(["chat-a", "chat-b", "chat-c"])
  })
})

describe("chatStatusOf", () => {
  it("keeps known statuses and treats anything else as unloaded", () => {
    expect(chatStatusOf("streaming")).toBe("streaming")
    expect(chatStatusOf("awaiting_approval")).toBe("awaiting_approval")
    expect(chatStatusOf(undefined)).toBeNull()
    expect(chatStatusOf("warming")).toBeNull()
  })
})

describe("conversationFacts", () => {
  it("proves a conversation only from a visible chat row", () => {
    const facts = conversationFacts({ "chat-a": "streaming", "chat-b": null }, [
      chatRow({ id: "chat-a", title: "Refactor auth", kind: "direct" }),
      chatRow({ id: "chat-b", title: "" }),
      chatRow({ id: "room", title: "Standup", kind: "team" }),
      chatRow({ id: "bench", title: "Workbench", visibility: "embedded" }),
    ])
    expect(facts).toEqual({
      "chat-a": { direct: true, status: "streaming", title: "Refactor auth" },
      // A row written before `kind` existed is an ordinary chat.
      "chat-b": { direct: true, status: null },
      // A team room is a conversation, but not one the chat runtime drives.
      room: { direct: false, status: null, title: "Standup" },
    })
  })
})
