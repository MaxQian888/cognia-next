import {
  buildConversationHistory,
  historyAsClaudeMessages,
  historyAsTextPreamble,
  type ConversationTurn,
} from "./conversation-context"
import type { AgentTeamMessage } from "@/types/agent/agent-team"
import { TEAM_USER_SENDER_ID } from "@/types/agent/agent-team"

function msg(
  partial: Partial<AgentTeamMessage> & Pick<AgentTeamMessage, "id" | "senderId" | "content">
): AgentTeamMessage {
  return {
    teamId: "team1",
    type: "direct",
    senderName: partial.senderId === TEAM_USER_SENDER_ID ? "You" : `Agent-${partial.senderId}`,
    read: true,
    timestamp: partial.timestamp ?? new Date("2026-05-08T10:00:00Z"),
    ...partial,
  } as AgentTeamMessage
}

describe("buildConversationHistory", () => {
  it("returns empty array when no messages", () => {
    expect(buildConversationHistory([])).toEqual([])
  })

  it("classifies user vs assistant by sender id and orders by timestamp", () => {
    const messages: AgentTeamMessage[] = [
      msg({
        id: "2",
        senderId: "agent-a",
        senderName: "Claude",
        content: "Hello!",
        timestamp: new Date(2000),
      }),
      msg({
        id: "1",
        senderId: TEAM_USER_SENDER_ID,
        senderName: "You",
        content: "@claude hi",
        timestamp: new Date(1000),
      }),
    ]
    const turns = buildConversationHistory(messages)
    expect(turns).toHaveLength(2)
    expect(turns[0].role).toBe("user")
    expect(turns[0].content).toBe("@claude hi")
    expect(turns[1].role).toBe("assistant")
    expect(turns[1].speakerName).toBe("Claude")
  })

  it("filters out streaming, errored, empty, and structured-payload messages", () => {
    const messages: AgentTeamMessage[] = [
      msg({ id: "1", senderId: TEAM_USER_SENDER_ID, content: "ok" }),
      msg({ id: "2", senderId: "a", content: "streaming...", metadata: { streaming: true } }),
      msg({ id: "3", senderId: "a", content: "fail", metadata: { errored: true } }),
      msg({ id: "4", senderId: "a", content: "" }),
      msg({
        id: "5",
        senderId: "a",
        content: "structured",
        structuredPayload: { type: "idle_notification" },
      }),
      msg({ id: "6", senderId: "a", content: "valid response" }),
    ]
    const turns = buildConversationHistory(messages)
    expect(turns.map((t) => t.content)).toEqual(["ok", "valid response"])
  })

  it("filters out non-conversational types (task_update / plan_approval / shutdown)", () => {
    const messages: AgentTeamMessage[] = [
      msg({ id: "1", senderId: TEAM_USER_SENDER_ID, content: "user msg", type: "direct" }),
      msg({ id: "2", senderId: "a", content: "task update", type: "task_update" }),
      msg({ id: "3", senderId: "a", content: "plan approval", type: "plan_approval" }),
      msg({ id: "4", senderId: "a", content: "broadcast text", type: "broadcast" }),
    ]
    const turns = buildConversationHistory(messages)
    expect(turns.map((t) => t.content)).toEqual(["user msg", "broadcast text"])
  })

  it("excludes messages by id when excludeMessageIds is set", () => {
    const messages: AgentTeamMessage[] = [
      msg({ id: "1", senderId: TEAM_USER_SENDER_ID, content: "kept" }),
      msg({ id: "2", senderId: TEAM_USER_SENDER_ID, content: "skipped" }),
    ]
    const turns = buildConversationHistory(messages, { excludeMessageIds: ["2"] })
    expect(turns).toHaveLength(1)
    expect(turns[0].content).toBe("kept")
  })

  it("caps to maxTurns most recent", () => {
    const messages: AgentTeamMessage[] = Array.from({ length: 5 }, (_, i) =>
      msg({
        id: String(i),
        senderId: TEAM_USER_SENDER_ID,
        content: `m${i}`,
        timestamp: new Date(1000 + i),
      })
    )
    const turns = buildConversationHistory(messages, { maxTurns: 2 })
    expect(turns.map((t) => t.content)).toEqual(["m3", "m4"])
  })

  it("defaults maxTurns to 20", () => {
    const messages: AgentTeamMessage[] = Array.from({ length: 25 }, (_, i) =>
      msg({
        id: String(i),
        senderId: TEAM_USER_SENDER_ID,
        content: `m${i}`,
        timestamp: new Date(1000 + i),
      })
    )
    const turns = buildConversationHistory(messages)
    expect(turns).toHaveLength(20)
    expect(turns[0].content).toBe("m5")
    expect(turns[19].content).toBe("m24")
  })
})

describe("historyAsClaudeMessages", () => {
  it("returns empty for no turns", () => {
    expect(historyAsClaudeMessages([])).toEqual([])
  })

  it("maps roles directly when alternating", () => {
    const turns: ConversationTurn[] = [
      { role: "user", speakerName: "You", content: "hi", timestamp: new Date() },
      { role: "assistant", speakerName: "Claude", content: "hello", timestamp: new Date() },
    ]
    expect(historyAsClaudeMessages(turns)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "[Claude]: hello" },
    ])
  })

  it("merges consecutive same-role turns with double-newline", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", speakerName: "Claude", content: "first", timestamp: new Date() },
      { role: "assistant", speakerName: "Codex", content: "second", timestamp: new Date() },
    ]
    const result = historyAsClaudeMessages(turns)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("assistant")
    expect(result[0].content).toBe("[Claude]: first\n\n[Codex]: second")
  })

  it("does not label user turns with speaker name", () => {
    const turns: ConversationTurn[] = [
      { role: "user", speakerName: "You", content: "@claude help", timestamp: new Date() },
    ]
    expect(historyAsClaudeMessages(turns)).toEqual([{ role: "user", content: "@claude help" }])
  })
})

describe("historyAsTextPreamble", () => {
  it("returns empty string when no turns", () => {
    expect(historyAsTextPreamble([])).toBe("")
  })

  it("formats history with You + speaker labels", () => {
    const turns: ConversationTurn[] = [
      { role: "user", speakerName: "You", content: "hi", timestamp: new Date() },
      { role: "assistant", speakerName: "Claude", content: "hello", timestamp: new Date() },
    ]
    const out = historyAsTextPreamble(turns)
    expect(out).toContain("[Conversation so far]")
    expect(out).toContain("You: hi")
    expect(out).toContain("Claude: hello")
    expect(out.endsWith("\n")).toBe(true)
  })
})
