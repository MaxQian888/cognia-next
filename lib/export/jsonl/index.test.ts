import { exportToJsonlPerMessage, exportToJsonlChat, enumerateBranchPaths } from "./index"
import type { StoredMessage } from "@cognia/agent-config-types"

function msg(
  id: string,
  role: StoredMessage["role"],
  text: string,
  extra: Partial<StoredMessage> = {}
): StoredMessage {
  return {
    id,
    sessionId: "s1",
    role,
    parts: [{ type: "text", text }] as StoredMessage["parts"],
    createdAt: Number(id.replace(/\D/g, "")) || 0,
    ...extra,
  }
}

describe("exportToJsonlPerMessage", () => {
  it("emits one JSON object per line in order", () => {
    const out = exportToJsonlPerMessage([msg("1", "user", "hi"), msg("2", "assistant", "yo")])
    const lines = out.split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toMatchObject({ id: "1", role: "user", createdAt: 1 })
    expect(JSON.parse(lines[1])).toMatchObject({ id: "2", role: "assistant" })
  })

  it("carries branch metadata and senderId when present", () => {
    const out = exportToJsonlPerMessage([
      msg("1", "assistant", "a", {
        senderId: "char_x",
        metadata: { branchGroupId: "g1", branchIndex: 2 },
      }),
    ])
    expect(JSON.parse(out)).toMatchObject({
      senderId: "char_x",
      branchGroupId: "g1",
      branchIndex: 2,
    })
  })

  it("collapses to the highest-index sibling when allBranches is false", () => {
    const msgs = [
      msg("1", "user", "q"),
      msg("2", "assistant", "v0", { metadata: { branchGroupId: "g", branchIndex: 0 } }),
      msg("3", "assistant", "v1", { metadata: { branchGroupId: "g", branchIndex: 1 } }),
    ]
    const out = exportToJsonlPerMessage(msgs, false)
    const lines = out.split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]).id).toBe("3")
  })

  it("keeps every sibling when allBranches is true", () => {
    const msgs = [
      msg("2", "assistant", "v0", { metadata: { branchGroupId: "g", branchIndex: 0 } }),
      msg("3", "assistant", "v1", { metadata: { branchGroupId: "g", branchIndex: 1 } }),
    ]
    expect(exportToJsonlPerMessage(msgs, true).split("\n")).toHaveLength(2)
  })
})

describe("enumerateBranchPaths", () => {
  it("returns the whole list as a single path when there are no groups", () => {
    const msgs = [msg("1", "user", "a"), msg("2", "assistant", "b")]
    expect(enumerateBranchPaths(msgs, true)).toEqual([msgs])
  })

  it("picks the highest-index sibling per group when allBranches is false", () => {
    const msgs = [
      msg("1", "user", "q"),
      msg("2", "assistant", "v0", { metadata: { branchGroupId: "g", branchIndex: 0 } }),
      msg("3", "assistant", "v1", { metadata: { branchGroupId: "g", branchIndex: 1 } }),
    ]
    const paths = enumerateBranchPaths(msgs, false)
    expect(paths).toHaveLength(1)
    expect(paths[0].map((m) => m.id)).toEqual(["1", "3"])
  })

  it("enumerates the cartesian product across groups when allBranches is true", () => {
    const msgs = [
      msg("1", "assistant", "a0", { metadata: { branchGroupId: "g1", branchIndex: 0 } }),
      msg("2", "assistant", "a1", { metadata: { branchGroupId: "g1", branchIndex: 1 } }),
      msg("3", "assistant", "b0", { metadata: { branchGroupId: "g2", branchIndex: 0 } }),
      msg("4", "assistant", "b1", { metadata: { branchGroupId: "g2", branchIndex: 1 } }),
    ]
    const paths = enumerateBranchPaths(msgs, true)
    // 2 × 2 = 4 distinct root→leaf paths.
    expect(paths).toHaveLength(4)
    for (const p of paths) expect(p).toHaveLength(2)
  })
})

describe("exportToJsonlChat", () => {
  it("emits one conversation line with role/content pairs", () => {
    const out = exportToJsonlChat([msg("1", "user", "hi"), msg("2", "assistant", "yo")])
    const parsed = JSON.parse(out)
    expect(parsed).toEqual({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
      ],
    })
  })

  it("drops empty (tool-only) turns", () => {
    const toolOnly = msg("2", "assistant", "")
    toolOnly.parts = [{ type: "tool-foo" }] as unknown as StoredMessage["parts"]
    const out = exportToJsonlChat([msg("1", "user", "hi"), toolOnly])
    expect(JSON.parse(out).messages).toEqual([{ role: "user", content: "hi" }])
  })

  it("emits one line per path when allBranches is on", () => {
    const msgs = [
      msg("1", "user", "q"),
      msg("2", "assistant", "v0", { metadata: { branchGroupId: "g", branchIndex: 0 } }),
      msg("3", "assistant", "v1", { metadata: { branchGroupId: "g", branchIndex: 1 } }),
    ]
    const lines = exportToJsonlChat(msgs, true).split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).messages.map((m: { content: string }) => m.content)).toEqual([
      "q",
      "v0",
    ])
    expect(JSON.parse(lines[1]).messages[1].content).toBe("v1")
  })
})
