/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  addKnowledgeNote,
  deleteKnowledgeNote,
  findKnowledgeNoteBySourceDraft,
  getKnowledgeNote,
  listKnowledgeNotes,
  listKnowledgeNotesByTag,
  type KnowledgeNoteRow,
} from "./knowledge-notes"
import { getDb } from "./schema"

function note(id: string, overrides: Partial<KnowledgeNoteRow> = {}): KnowledgeNoteRow {
  return {
    id,
    title: id,
    body: `<untrusted_content>\n${id}\n</untrusted_content>`,
    tags: [],
    sourceDraftId: `draft-${id}`,
    createdAt: 1000,
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().knowledgeNotes.clear()
}, 30_000)

describe("knowledge-notes CRUD", () => {
  it("round-trips a note with its untrusted envelope intact", async () => {
    await addKnowledgeNote(note("n1", { url: "https://example.com", source: "claude-code" }))

    const stored = await getKnowledgeNote("n1")
    // A note originates outside Cognia; the envelope must survive storage.
    expect(stored?.body).toContain("<untrusted_content>")
    expect(stored?.url).toBe("https://example.com")
    expect(stored?.source).toBe("claude-code")
  })

  it("lists newest-first and honours the limit", async () => {
    await addKnowledgeNote(note("old", { createdAt: 1 }))
    await addKnowledgeNote(note("new", { createdAt: 9 }))
    await addKnowledgeNote(note("mid", { createdAt: 5 }))

    expect((await listKnowledgeNotes()).map((n) => n.id)).toEqual(["new", "mid", "old"])
    expect(await listKnowledgeNotes(2)).toHaveLength(2)
  })

  it("finds a note by the draft it was materialized from", async () => {
    await addKnowledgeNote(note("n1", { sourceDraftId: "draft-42" }))

    expect((await findKnowledgeNoteBySourceDraft("draft-42"))?.id).toBe("n1")
    // The lookup is what makes a replayed materialization a no-op.
    expect(await findKnowledgeNoteBySourceDraft("draft-unknown")).toBeUndefined()
  })

  it("filters by tag, newest-first", async () => {
    await addKnowledgeNote(note("a", { tags: ["rust", "perf"], createdAt: 1 }))
    await addKnowledgeNote(note("b", { tags: ["rust"], createdAt: 5 }))
    await addKnowledgeNote(note("c", { tags: ["ui"], createdAt: 9 }))

    expect((await listKnowledgeNotesByTag("rust")).map((n) => n.id)).toEqual(["b", "a"])
    expect(await listKnowledgeNotesByTag("missing")).toEqual([])
    expect(await listKnowledgeNotesByTag("rust", 1)).toHaveLength(1)
  })

  it("deletes a note", async () => {
    await addKnowledgeNote(note("n1"))
    await deleteKnowledgeNote("n1")
    expect(await getKnowledgeNote("n1")).toBeUndefined()
  })
})
