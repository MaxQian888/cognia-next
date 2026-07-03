import { resolveConversationDrop, type DndNode } from "./conversation-dnd"

const sess = (id: string, folderId: string | null = null): DndNode => ({
  id,
  data: { type: "session", folderId },
})
const folder = (folderId: string | null): DndNode => ({
  id: `folder:${folderId}`,
  data: { type: "folder", folderId },
})

describe("resolveConversationDrop", () => {
  it("returns null when active or over is missing, or they are identical", () => {
    expect(resolveConversationDrop(null, folder("f1"), [])).toBeNull()
    expect(resolveConversationDrop(sess("a"), null, [])).toBeNull()
    expect(resolveConversationDrop(sess("a"), sess("a"), ["a"])).toBeNull()
  })

  it("assigns a conversation to the folder it was dropped on", () => {
    expect(resolveConversationDrop(sess("a", null), folder("f1"), [])).toEqual({
      type: "assign",
      sessionId: "a",
      folderId: "f1",
    })
  })

  it("no-ops when dropped on the folder it already belongs to", () => {
    expect(resolveConversationDrop(sess("a", "f1"), folder("f1"), [])).toBeNull()
  })

  it("treats a folder with null id as unfiling", () => {
    expect(resolveConversationDrop(sess("a", "f1"), folder(null), [])).toEqual({
      type: "assign",
      sessionId: "a",
      folderId: null,
    })
  })

  it("reorders within the pinned section when dropped on another pinned row", () => {
    // Move "c" before "a": [a,b,c] with active c over a → [c,a,b]
    expect(resolveConversationDrop(sess("c"), sess("a"), ["a", "b", "c"])).toEqual({
      type: "reorder",
      ids: ["c", "a", "b"],
    })
  })

  it("returns null when either end of a reorder is not pinned", () => {
    expect(resolveConversationDrop(sess("x"), sess("a"), ["a", "b"])).toBeNull()
    expect(resolveConversationDrop(sess("a"), sess("x"), ["a", "b"])).toBeNull()
  })
})
