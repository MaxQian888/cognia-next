import type { UIMessage } from "ai"
import {
  editBranchGroupId,
  senderIdOf,
  tagBranchSiblings,
  tagEditSibling,
  teamBranchGroupId,
} from "./branch-regen"

function msg(
  id: string,
  role: "user" | "assistant",
  metadata?: Record<string, unknown>
): UIMessage {
  return { id, role, parts: [{ type: "text", text: id }], metadata } as unknown as UIMessage
}

describe("tagBranchSiblings", () => {
  it("stamps untagged siblings into one group with sequential indexes (direct-chat shape)", () => {
    const messages = [msg("u1", "user"), msg("a1", "assistant"), msg("a2", "assistant")]
    const { merged, nextIndexByGroup } = tagBranchSiblings(messages, 0, () => "u1")
    expect(merged).toHaveLength(3)
    expect(merged[1].metadata).toMatchObject({ branchGroupId: "u1", branchIndex: 0 })
    expect(merged[2].metadata).toMatchObject({ branchGroupId: "u1", branchIndex: 1 })
    expect(nextIndexByGroup.get("u1")).toBe(2)
  })

  it("preserves prior branch tags and only fills missing fields", () => {
    const messages = [
      msg("u1", "user"),
      msg("a1", "assistant", { branchGroupId: "g-old", branchIndex: 3 }),
    ]
    const { merged, nextIndexByGroup } = tagBranchSiblings(messages, 0, () => "u1")
    expect(merged[1].metadata).toMatchObject({ branchGroupId: "g-old", branchIndex: 3 })
    expect(nextIndexByGroup.get("g-old")).toBe(4)
    expect(nextIndexByGroup.has("u1")).toBe(false)
  })

  it("keeps the prefix intact and drops non-assistant messages after the anchor", () => {
    const messages = [
      msg("u0", "user"),
      msg("a0", "assistant"),
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("u-stray", "user"),
    ]
    const { merged } = tagBranchSiblings(messages, 2, () => "u1")
    expect(merged.map((m) => m.id)).toEqual(["u0", "a0", "u1", "a1"])
    // The prefix (including earlier replies) is untouched.
    expect(merged[1].metadata).toBeUndefined()
  })

  it("supports per-member groups via a stateful groupIdOf (team shape)", () => {
    const messages = [
      msg("u1", "user"),
      msg("a-alice", "assistant", { senderId: "alice" }),
      msg("a-bob", "assistant", { senderId: "bob" }),
      msg("a-alice-2", "assistant", { senderId: "alice" }),
    ]
    const seen = new Map<string, number>()
    const { merged, nextIndexByGroup } = tagBranchSiblings(messages, 0, (m) => {
      const sender = senderIdOf(m)
      const ord = seen.get(sender) ?? 0
      seen.set(sender, ord + 1)
      return teamBranchGroupId("u1", sender, ord)
    })
    expect(merged[1].metadata).toMatchObject({ branchGroupId: "u1::alice::0", branchIndex: 0 })
    expect(merged[2].metadata).toMatchObject({ branchGroupId: "u1::bob::0", branchIndex: 0 })
    // Alice's second reply (supervisor-round shape) gets its own group, so
    // the one-visible-per-group rule can't hide her first reply.
    expect(merged[3].metadata).toMatchObject({ branchGroupId: "u1::alice::1", branchIndex: 0 })
    expect(nextIndexByGroup.get("u1::alice::0")).toBe(1)
  })
})

describe("senderIdOf", () => {
  it("reads metadata.senderId and falls back to 'assistant'", () => {
    expect(senderIdOf(msg("a", "assistant", { senderId: "x" }))).toBe("x")
    expect(senderIdOf(msg("a", "assistant"))).toBe("assistant")
  })
})

describe("tagEditSibling", () => {
  // Editing used to `truncateAfter(..., { inclusive: true })` — the original
  // question and every reply beneath it were deleted outright, so rewording a
  // question halfway up a thread destroyed the rest of it with no undo.

  it("puts the original into a branch group and re-parents its whole tail", () => {
    const messages = [
      msg("u0", "user"),
      msg("a0", "assistant"),
      msg("u1", "user"), // ← edited
      msg("a1", "assistant"),
      msg("a2", "assistant"),
    ]
    const { merged, groupId, nextIndex } = tagEditSibling(messages, 2)

    expect(groupId).toBe(editBranchGroupId("u1"))
    // Everything before the edit is untouched, by identity.
    expect(merged[0]).toBe(messages[0])
    expect(merged[1]).toBe(messages[1])
    // The original joins the group…
    expect(merged[2].metadata).toMatchObject({ branchGroupId: groupId, branchIndex: 0 })
    // …and its replies now hang off it, so they hide when it is deselected.
    expect(merged[3].metadata).toMatchObject({ branchOwnerId: "u1" })
    expect(merged[4].metadata).toMatchObject({ branchOwnerId: "u1" })
    // Nothing was dropped.
    expect(merged).toHaveLength(5)
    expect(nextIndex).toBe(1)
  })

  it("allocates a fresh index each time the same message is edited again", () => {
    const messages = [
      msg("u1", "user", { branchGroupId: "edit::u1", branchIndex: 0 }),
      msg("u1b", "user", { branchGroupId: "edit::u1", branchIndex: 1 }),
      msg("a1", "assistant"),
    ]
    const { groupId, nextIndex } = tagEditSibling(messages, 0)
    expect(groupId).toBe("edit::u1")
    // Must clear BOTH existing variants, not just the edited one's own index.
    expect(nextIndex).toBe(2)
  })

  it("leaves a nearer ancestor's ownership in place", () => {
    // A message already owned by an inner sibling must keep pointing there —
    // `selectVisibleMessages` walks up transitively from the nearest owner, so
    // overwriting would flatten a nested edit onto the outer one.
    const messages = [
      msg("u1", "user"),
      msg("inner", "assistant", { branchOwnerId: "someone-else" }),
      msg("plain", "assistant"),
    ]
    const { merged } = tagEditSibling(messages, 0)
    expect(merged[1].metadata).toMatchObject({ branchOwnerId: "someone-else" })
    expect(merged[2].metadata).toMatchObject({ branchOwnerId: "u1" })
  })

  it("handles editing the very last message (empty tail)", () => {
    const messages = [msg("u0", "user"), msg("a0", "assistant"), msg("u1", "user")]
    const { merged, nextIndex } = tagEditSibling(messages, 2)
    expect(merged).toHaveLength(3)
    expect(merged[2].metadata).toMatchObject({ branchIndex: 0 })
    expect(nextIndex).toBe(1)
  })
})
