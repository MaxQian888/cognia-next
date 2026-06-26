import type { UIMessage } from "ai"
import type { SubAgent } from "@/types/agent/sub-agent"
import {
  applySubagentUpdate,
  selectSessionSubagents,
  applySubagentsToMessages,
  subagentSignature,
} from "./subagent-bridge"
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

function withSession(sa: SubAgent, sessionId: string): SubAgent {
  return {
    ...sa,
    context: {
      parentAgentId: sa.parentAgentId,
      sessionId,
      startTime: sa.createdAt,
      currentStep: 0,
    },
  }
}

describe("selectSessionSubagents", () => {
  it("returns only the roots whose context.sessionId matches", () => {
    const a = withSession(makeSubAgent({ id: "a" }), "sess-1")
    const b = withSession(makeSubAgent({ id: "b" }), "sess-2")
    const record = { a, b }
    const out = selectSessionSubagents(record, "sess-1")
    expect(out.map((s) => s.id)).toEqual(["a"])
  })

  it("includes transitive descendants linked by parentSubagentId", () => {
    const root = withSession(makeSubAgent({ id: "root" }), "sess-1")
    const child = makeSubAgent({ id: "child", parentSubagentId: "root" }) // ephemeral session
    const grandchild = makeSubAgent({ id: "gc", parentSubagentId: "child" })
    const unrelated = makeSubAgent({ id: "x", parentSubagentId: "other" })
    const out = selectSessionSubagents({ root, child, grandchild, unrelated }, "sess-1")
    expect(out.map((s) => s.id).sort()).toEqual(["child", "gc", "root"])
  })

  it("returns [] when no root matches the session", () => {
    const a = withSession(makeSubAgent({ id: "a" }), "other")
    expect(selectSessionSubagents({ a }, "sess-1")).toEqual([])
  })
})

describe("applySubagentsToMessages", () => {
  it("folds multiple subagents onto the assistant message", () => {
    const msgs: UIMessage[] = [assistantMessage("a1")]
    const out = applySubagentsToMessages(msgs, [
      makeSubAgent({ id: "s1" }),
      makeSubAgent({ id: "s2" }),
    ])
    const parts = ((out[0].parts ?? []) as unknown[]).filter(isSubagentPart) as SubagentPart[]
    expect(parts.map((p) => p.subagentId).sort()).toEqual(["s1", "s2"])
  })

  it("returns the same reference when given no subagents", () => {
    const msgs: UIMessage[] = [assistantMessage("a1")]
    expect(applySubagentsToMessages(msgs, [])).toBe(msgs)
  })
})

describe("subagentSignature", () => {
  it("changes when status changes, stable otherwise", () => {
    const base = makeSubAgent({ id: "s1", status: "running", progress: 10 })
    const sig1 = subagentSignature([base])
    expect(subagentSignature([{ ...base }])).toBe(sig1)
    expect(subagentSignature([{ ...base, status: "completed" }])).not.toBe(sig1)
  })

  it("IGNORES progress changes (the transcript card never renders progress)", () => {
    const base = makeSubAgent({ id: "s1", status: "running", progress: 10 })
    const sig1 = subagentSignature([base])
    expect(subagentSignature([{ ...base, progress: 50 }])).toBe(sig1)
    expect(subagentSignature([{ ...base, progress: 95 }])).toBe(sig1)
  })

  it("changes when the final-response summary appears", () => {
    const base = makeSubAgent({ id: "s1", status: "running" })
    const sig1 = subagentSignature([base])
    const withSummary = makeSubAgent({
      id: "s1",
      status: "running",
      result: { finalResponse: "done", success: true, steps: [], totalSteps: 0, duration: 0 },
    })
    expect(subagentSignature([withSummary])).not.toBe(sig1)
  })

  it("is order-independent", () => {
    const a = makeSubAgent({ id: "a" })
    const b = makeSubAgent({ id: "b" })
    expect(subagentSignature([a, b])).toBe(subagentSignature([b, a]))
  })
})
