import type { ChatSession } from "@cognia/agent-config-types"

import type { ConversationSection } from "./conversation-list-model"
import {
  projectPendingReorder,
  resolveConversationDrop,
  resolveConversationDropPreview,
  type DndNode,
  type PendingReorder,
} from "./conversation-dnd"

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

  it("rejects a drop onto a folder that belongs to another workspace", () => {
    // The list can span every workspace (`groupBy: "workspace"`) while the
    // folders it carries belong to the active one. Filing a foreign row would
    // stick a folderId on it that is not loaded where the conversation lives.
    const foreign: DndNode = { id: "a", data: { type: "session", folderId: null, projectId: "w2" } }
    const target: DndNode = {
      id: "folder:f1",
      data: { type: "folder", folderId: "f1", projectId: "w1" },
    }
    expect(resolveConversationDrop(foreign, target, [])).toBeNull()
  })

  it("allows the drop when the workspaces match, or when either side is unknown", () => {
    const own: DndNode = { id: "a", data: { type: "session", folderId: null, projectId: "w1" } }
    const scoped: DndNode = {
      id: "folder:f1",
      data: { type: "folder", folderId: "f1", projectId: "w1" },
    }
    const legacyFolder: DndNode = { id: "folder:f1", data: { type: "folder", folderId: "f1" } }
    expect(resolveConversationDrop(own, scoped, [])).toEqual({
      type: "assign",
      sessionId: "a",
      folderId: "f1",
    })
    expect(resolveConversationDrop(own, legacyFolder, [])).toEqual({
      type: "assign",
      sessionId: "a",
      folderId: "f1",
    })
  })

  it("still unfiles a foreign conversation dropped outside every folder", () => {
    // Unfiling touches no folder, so the workspace check must not block it.
    const foreign: DndNode = { id: "a", data: { type: "session", folderId: "f1", projectId: "w2" } }
    const loose: DndNode = { id: "folder:null", data: { type: "folder", folderId: null } }
    expect(resolveConversationDrop(foreign, loose, [])).toEqual({
      type: "assign",
      sessionId: "a",
      folderId: null,
    })
  })

  it("reorders within a section when dropped on another row in it", () => {
    // Move "c" before "a": [a,b,c] with active c over a → [c,a,b]
    expect(resolveConversationDrop(sess("c"), sess("a"), ["a", "b", "c"])).toEqual({
      type: "reorder",
      ids: ["c", "a", "b"],
    })
  })

  it("returns null when either end of a reorder is outside the section", () => {
    // Cross-section drag (e.g. between two date buckets): the dragged row (x)
    // isn't in the drop target's section, or vice versa → no manual-order meaning.
    expect(resolveConversationDrop(sess("x"), sess("a"), ["a", "b"])).toBeNull()
    expect(resolveConversationDrop(sess("a"), sess("x"), ["a", "b"])).toBeNull()
  })
})

describe("resolveConversationDropPreview", () => {
  it("places the cue before the target when moving upward", () => {
    expect(resolveConversationDropPreview("c", "a", ["a", "b", "c"])).toEqual({
      targetId: "a",
      position: "before",
    })
  })

  it("places the cue after the target when moving downward", () => {
    expect(resolveConversationDropPreview("a", "c", ["a", "b", "c"])).toEqual({
      targetId: "c",
      position: "after",
    })
  })

  it("does not preview a no-op or a cross-section drop", () => {
    expect(resolveConversationDropPreview("a", "a", ["a", "b"])).toBeNull()
    expect(resolveConversationDropPreview("outside", "a", ["a", "b"])).toBeNull()
  })
})

describe("projectPendingReorder", () => {
  const row = (id: string): ChatSession =>
    ({ id, title: id, createdAt: 0, updatedAt: 0 }) as unknown as ChatSession
  const [a, b, c, d] = [row("a"), row("b"), row("c"), row("d")]
  const sections: ConversationSection[] = [
    { kind: "pinned", sessions: [a, b, c] },
    { kind: "date", bucket: "today", sessions: [d] },
  ]
  const pending: PendingReorder = {
    sectionKey: "pinned",
    baseIds: ["a", "b", "c"],
    ids: ["b", "a", "c"],
  }

  it("is idle without a pending reorder and returns the same sections", () => {
    expect(projectPendingReorder(sections, null)).toEqual({ sections, status: "idle" })
    expect(projectPendingReorder(sections, null).sections).toBe(sections)
  })

  it("projects the dropped order over the pre-drop snapshot, leaving other sections alone", () => {
    const result = projectPendingReorder(sections, pending)
    expect(result.status).toBe("applied")
    expect(result.sections[0].sessions).toEqual([b, a, c])
    // Untouched sections keep their identity — memoized rows do not re-render.
    expect(result.sections[1]).toBe(sections[1])
    expect(sections[0].sessions).toEqual([a, b, c])
  })

  it("settles once the store carries the dropped order", () => {
    const stored: ConversationSection[] = [{ kind: "pinned", sessions: [b, a, c] }]
    const result = projectPendingReorder(stored, pending)
    expect(result).toEqual({ sections: stored, status: "settled" })
  })

  it("goes stale when the section is gone, its membership changed, or another writer reordered it", () => {
    expect(projectPendingReorder([{ kind: "recent", sessions: [a, b, c] }], pending).status).toBe(
      "stale"
    )
    expect(projectPendingReorder([{ kind: "pinned", sessions: [a, b] }], pending).status).toBe(
      "stale"
    )
    expect(projectPendingReorder([{ kind: "pinned", sessions: [c, b, a] }], pending).status).toBe(
      "stale"
    )
    // A dropped order that is not a permutation of the snapshot cannot be
    // projected honestly either.
    expect(projectPendingReorder(sections, { ...pending, ids: ["b", "a", "zzz"] }).status).toBe(
      "stale"
    )
  })

  it("matches sections by their stable key, so a folder and a date bucket never collide", () => {
    const foldered: ConversationSection[] = [
      {
        kind: "folder",
        folder: { id: "f1", name: "F", order: 0, createdAt: 0, updatedAt: 0 },
        sessions: [a, b],
        collapsed: false,
      },
      { kind: "date", bucket: "today", sessions: [c, d] },
    ]
    const result = projectPendingReorder(foldered, {
      sectionKey: "date:today",
      baseIds: ["c", "d"],
      ids: ["d", "c"],
    })
    expect(result.status).toBe("applied")
    expect(result.sections[0]).toBe(foldered[0])
    expect(result.sections[1].sessions).toEqual([d, c])
  })
})
