import "fake-indexeddb/auto"
import { branchSessionAtMessage, renderTranscript } from "./branch-session"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { listMessages } from "@/lib/db/messages"
import type { ChatSession } from "@/lib/claude/types"
import type { UIMessage } from "ai"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function uiMsg(
  id: string,
  role: UIMessage["role"],
  text: string,
  meta?: Record<string, unknown>
): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    ...(meta ? { metadata: meta } : {}),
  } as UIMessage
}

async function seedSource(overrides: Partial<ChatSession> = {}): Promise<ChatSession> {
  const now = Date.now()
  const session: ChatSession = {
    id: "src1",
    title: "Original",
    kind: "direct",
    model: "claude-x",
    systemPrompt: "be nice",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  await getDb().sessions.put(session)
  return session
}

const visible = (): UIMessage[] => [
  uiMsg("u1", "user", "first question"),
  uiMsg("a1", "assistant", "first answer"),
  uiMsg("u2", "user", "second question"),
  uiMsg("a2", "assistant", "second answer"),
]

describe("renderTranscript", () => {
  it("labels roles and skips empty turns", () => {
    const empty = { id: "x", role: "assistant", parts: [{ type: "tool" }] } as unknown as UIMessage
    expect(renderTranscript([uiMsg("u", "user", "hi"), empty])).toBe("User: hi")
  })
})

describe("branchSessionAtMessage — validation", () => {
  it("throws when the source session is missing", async () => {
    await expect(
      branchSessionAtMessage({
        sourceId: "nope",
        visibleMessages: [],
        messageId: "x",
        mode: "direct",
      })
    ).rejects.toThrow(/not found/)
  })

  it("throws when the cut-off message is not visible", async () => {
    await seedSource()
    await expect(
      branchSessionAtMessage({
        sourceId: "src1",
        visibleMessages: visible(),
        messageId: "ghost",
        mode: "direct",
      })
    ).rejects.toThrow(/not in the visible thread/)
  })

  it("throws when summary mode has no summary text", async () => {
    await seedSource()
    await expect(
      branchSessionAtMessage({
        sourceId: "src1",
        visibleMessages: visible(),
        messageId: "a2",
        mode: "summary",
      })
    ).rejects.toThrow(/requires summaryText/)
  })
})

describe("branchSessionAtMessage — direct", () => {
  it("copies the truncated thread and inherits config + lineage", async () => {
    await seedSource()
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1",
      mode: "direct",
    })
    expect(child.id).not.toBe("src1")
    expect(child.parentSessionId).toBe("src1")
    expect(child.branchedFromMessageId).toBe("a1")
    expect(child.branchKind).toBe("direct")
    expect(child.model).toBe("claude-x")
    expect(child.systemPrompt).toBe("be nice")
    expect(child.title).toBe("Original (branch)")

    const msgs = await listMessages(child.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
    // Fresh ids, not the source ids.
    expect(msgs.map((m) => m.id)).not.toContain("u1")
  })

  it("mid-conversation branch stores a transcript seed and does not SDK-fork", async () => {
    await seedSource({ sdkSessionId: "sdk-1" })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1", // not the tail
      mode: "direct",
    })
    expect(child.forkedFromSdkSessionId).toBeUndefined()
    expect(child.branchSeed?.kind).toBe("transcript")
    expect(child.branchSeed?.content).toContain("User: first question")
    expect(child.branchSeed?.content).toContain("Assistant: first answer")
  })

  it("tail branch with an SDK session uses SDK fork instead of a seed", async () => {
    await seedSource({ sdkSessionId: "sdk-1" })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a2", // tail
      mode: "direct",
    })
    expect(child.forkedFromSdkSessionId).toBe("sdk-1")
    expect(child.branchSeed).toBeUndefined()
  })

  it("tail branch without an SDK session falls back to a transcript seed", async () => {
    await seedSource() // no sdkSessionId
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a2",
      mode: "direct",
    })
    expect(child.forkedFromSdkSessionId).toBeUndefined()
    expect(child.branchSeed?.kind).toBe("transcript")
  })

  it("strips regeneration-branch metadata from the copied messages", async () => {
    await seedSource()
    const withBranch: UIMessage[] = [
      uiMsg("u1", "user", "q"),
      uiMsg("a1", "assistant", "ans", { branchGroupId: "g", branchIndex: 1, senderId: "c1" }),
    ]
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: withBranch,
      messageId: "a1",
      mode: "direct",
    })
    const msgs = await listMessages(child.id)
    const meta = msgs[1].metadata as Record<string, unknown> | undefined
    expect(meta?.branchGroupId).toBeUndefined()
    expect(meta?.branchIndex).toBeUndefined()
    // senderId is preserved (round-trips via the messages column).
    expect(meta?.senderId).toBe("c1")
  })
})

describe("branchSessionAtMessage — summary", () => {
  it("seeds a single summary message and a summary branchSeed", async () => {
    await seedSource({ sdkSessionId: "sdk-1" })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a2",
      mode: "summary",
      summaryText: "We discussed two questions.",
    })
    expect(child.branchKind).toBe("summary")
    // Summary branches never SDK-fork (context is the summary).
    expect(child.forkedFromSdkSessionId).toBeUndefined()
    expect(child.branchSeed).toEqual({ kind: "summary", content: "We discussed two questions." })

    const msgs = await listMessages(child.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe("assistant")
    expect((msgs[0].metadata as Record<string, unknown>).branchSummary).toBe(true)
  })
})
