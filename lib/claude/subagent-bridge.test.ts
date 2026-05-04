import type { UIMessage } from "ai"
import type { SubAgent } from "@/types/agent/sub-agent"
import { applySubagentUpdate } from "./subagent-bridge"
import { isSubagentPart, type SubagentPart } from "./parts-extensions"

function assistantMessage(id: string, parts: unknown[] = []): UIMessage {
  return { id, role: "assistant", parts } as unknown as UIMessage
}

function userMessage(id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: "hi" }] } as unknown as UIMessage
}

function makeSubAgent(overrides: Partial<SubAgent> = {}): SubAgent {
  return {
    id: "sa-1",
    parentAgentId: "parent-1",
    name: "Researcher",
    description: "",
    task: "find sources",
    initialTask: "find sources",
    threadId: "t",
    status: "running",
    config: {},
    messages: [],
    sources: [],
    logs: [],
    progress: 25,
    createdAt: new Date(2026, 4, 1, 12, 0, 0),
    lastActivityAt: new Date(2026, 4, 1, 12, 0, 0),
    retryCount: 0,
    order: 0,
    ...overrides,
  }
}

describe("applySubagentUpdate", () => {
  it("appends a new SubagentPart to the most recent assistant message when no parent id matches", () => {
    const msgs: UIMessage[] = [userMessage("u1"), assistantMessage("a1")]
    const out = applySubagentUpdate(msgs, makeSubAgent())
    const subParts = ((out[1].parts ?? []) as unknown[]).filter(isSubagentPart) as SubagentPart[]
    expect(subParts).toHaveLength(1)
    expect(subParts[0].subagentId).toBe("sa-1")
    expect(subParts[0].name).toBe("Researcher")
  })

  it("respects parentMessageId when provided and that id exists", () => {
    const msgs: UIMessage[] = [
      userMessage("u1"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantMessage("a2"),
    ]
    const out = applySubagentUpdate(msgs, makeSubAgent(), { parentMessageId: "a1" })
    expect((out[1].parts ?? []).filter(isSubagentPart)).toHaveLength(1)
    expect((out[3].parts ?? []).filter(isSubagentPart)).toHaveLength(0)
  })

  it("idempotent: replaying the same subagent id replaces the existing part in place", () => {
    const msgs: UIMessage[] = [assistantMessage("a1")]
    const sa = makeSubAgent()
    let next = applySubagentUpdate(msgs, sa)
    next = applySubagentUpdate(next, { ...sa, progress: 80 })
    const subParts = ((next[0].parts ?? []) as unknown[]).filter(isSubagentPart) as SubagentPart[]
    expect(subParts).toHaveLength(1)
    expect(subParts[0].progress).toBe(80)
  })

  it("preserves non-subagent parts intact", () => {
    const text = { type: "text" as const, text: "hello" }
    const msgs: UIMessage[] = [assistantMessage("a1", [text])]
    const out = applySubagentUpdate(msgs, makeSubAgent())
    const parts = out[0].parts ?? []
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual(text)
    expect(isSubagentPart(parts[1])).toBe(true)
  })

  it("returns the original list unchanged when there's no assistant message", () => {
    const msgs: UIMessage[] = [userMessage("u1")]
    const out = applySubagentUpdate(msgs, makeSubAgent())
    expect(out).toEqual(msgs)
  })

  it("uses subAgent.completedAt when present, else leaves undefined", () => {
    const completedAt = new Date(2026, 4, 1, 12, 5, 0)
    const msgs: UIMessage[] = [assistantMessage("a1")]
    const out = applySubagentUpdate(msgs, makeSubAgent({ status: "completed", completedAt }))
    const part = ((out[0].parts ?? []) as unknown[]).filter(isSubagentPart)[0] as SubagentPart
    expect(part.completedAt).toBe(completedAt.getTime())
  })

  it("falls back to createdAt when startedAt is missing", () => {
    const msgs: UIMessage[] = [assistantMessage("a1")]
    const sa = makeSubAgent({ startedAt: undefined })
    const out = applySubagentUpdate(msgs, sa)
    const part = ((out[0].parts ?? []) as unknown[]).filter(isSubagentPart)[0] as SubagentPart
    expect(part.startedAt).toBe(sa.createdAt.getTime())
  })

  it("uses the SubAgent's parentAgentId metadata-match when present", () => {
    const a1 = {
      ...assistantMessage("a1"),
      metadata: { parentAgentId: "wanted" },
    } as unknown as UIMessage
    const a2 = assistantMessage("a2")
    const msgs: UIMessage[] = [userMessage("u1"), a1, userMessage("u2"), a2]
    const out = applySubagentUpdate(msgs, makeSubAgent({ parentAgentId: "wanted" }))
    expect((out[1].parts ?? []).filter(isSubagentPart)).toHaveLength(1)
  })
})
