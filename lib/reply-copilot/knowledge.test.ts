import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import type { CopilotTranscript } from "./build-state"
import { KNOWLEDGE_BUDGET_CHARS, RECALL_WINDOW, gatherKnowledge } from "./knowledge"

const transcript: CopilotTranscript = {
  turns: Array.from({ length: 8 }, (_, i) => ({ from: i % 2 ? "me" : "other", text: `turn ${i}` })),
  latestFrom: "me",
  latestOtherSender: null,
  isGroup: false,
}

const contact = {
  id: "pid_1",
  platform: "telegram",
  remoteUserId: "u1",
  displayName: "Ann",
  relationship: "manager",
  note: "prefers short replies",
} as PlatformIdentityRow

describe("gatherKnowledge", () => {
  it("always includes the contact profile, and skips memory when not allowed", async () => {
    const recall = jest.fn()
    const k = await gatherKnowledge({ transcript, contact, memoryAllowed: false }, { recall })
    expect(k).toEqual({
      relationship: "manager",
      background: "About this contact: prefers short replies",
      contactId: "pid_1",
      contactName: "Ann",
      hasNote: true,
      memoryLines: 0,
      memorySkipped: "disabled",
    })
    expect(recall).not.toHaveBeenCalled()
  })

  it("recalls against the latest turns only and appends memory lines", async () => {
    const recall = jest.fn(async (_query: string) => ["likes tea", "  ", "birthday in May"])
    const k = await gatherKnowledge({ transcript, contact, memoryAllowed: true }, { recall })
    const query = recall.mock.calls[0][0]
    expect(query.split("\n")).toHaveLength(RECALL_WINDOW)
    expect(query).not.toContain("turn 0")
    expect(k.memoryLines).toBe(2)
    expect(k.background).toContain("What you remember:\n- likes tea\n- birthday in May")
    expect(k.memorySkipped).toBeNull()
  })

  it("redacts the recall query and drops PII-bearing memories", async () => {
    const recall = jest.fn(async (_query: string) => ["email is a@b.co", "fine line"])
    const withPhone: CopilotTranscript = {
      ...transcript,
      turns: [{ from: "other", text: "call 13812345678" }],
    }
    const k = await gatherKnowledge(
      { transcript: withPhone, contact: null, memoryAllowed: true },
      { recall }
    )
    expect(recall.mock.calls[0][0]).not.toContain("13812345678")
    expect(k.background).toBe("What you remember:\n- fine line")
    expect(k.contactId).toBeNull()
  })

  it("stays inside the budget by dropping the least relevant memories", async () => {
    const long = "m".repeat(400)
    const recall = jest.fn(async () => [long, long, long, long, long])
    const k = await gatherKnowledge({ transcript, contact, memoryAllowed: true }, { recall })
    expect(k.background.length + k.relationship.length).toBeLessThanOrEqual(
      KNOWLEDGE_BUDGET_CHARS + 60
    )
    expect(k.memoryLines).toBe(3)
  })

  it("reports an empty recall and survives a failing retriever", async () => {
    const k = await gatherKnowledge(
      { transcript, contact: null, memoryAllowed: true },
      { recall: async () => Promise.reject(new Error("backend down")) }
    )
    expect(k).toMatchObject({
      background: "",
      memoryLines: 0,
      memorySkipped: "empty",
      relationship: "",
    })
    const empty = await gatherKnowledge(
      { transcript: { ...transcript, turns: [] }, contact: null, memoryAllowed: true },
      { recall: jest.fn() }
    )
    expect(empty.memorySkipped).toBe("empty")
  })
})
