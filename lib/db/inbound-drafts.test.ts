import "fake-indexeddb/auto"
import {
  addInboundDraft,
  getInboundDraft,
  listInboundDrafts,
  listPendingInboundDrafts,
  setInboundDraftStatus,
  deleteInboundDraft,
  INBOUND_DRAFTS_CAP,
  type InboundDraftRow,
} from "./inbound-drafts"
import { getDb } from "./schema"

function draft(
  id: string,
  createdAt: number,
  overrides: Partial<InboundDraftRow> = {}
): InboundDraftRow {
  return {
    id,
    kind: "lesson",
    status: "pending",
    title: id,
    body: `<untrusted_content>\n${id}\n</untrusted_content>`,
    createdAt,
    ...overrides,
  }
}

// Cold-opening the versioned CogniaDB under fake-indexeddb can exceed the
// default 5s hook timeout on the first test; give it headroom.
beforeEach(async () => {
  await getDb().inboundDrafts.clear()
}, 30_000)

describe("inbound-drafts CRUD", () => {
  it("adds, reads, updates status, and deletes", async () => {
    await addInboundDraft(draft("a", 1000))
    expect((await getInboundDraft("a"))?.title).toBe("a")

    await setInboundDraftStatus("a", "accepted")
    expect((await getInboundDraft("a"))?.status).toBe("accepted")

    await deleteInboundDraft("a")
    expect(await getInboundDraft("a")).toBeUndefined()
  })

  it("lists all newest-first and pending-only", async () => {
    await addInboundDraft(draft("old", 1000))
    await addInboundDraft(draft("mid", 5000, { status: "accepted" }))
    await addInboundDraft(draft("new", 9000))

    expect((await listInboundDrafts()).map((d) => d.id)).toEqual(["new", "mid", "old"])
    expect((await listPendingInboundDrafts()).map((d) => d.id)).toEqual(["new", "old"])
  })

  it("respects the limit argument", async () => {
    for (let i = 0; i < 5; i++) {
      await addInboundDraft(draft(`d${i}`, i * 1000))
    }
    expect((await listInboundDrafts(2)).length).toBe(2)
    expect((await listPendingInboundDrafts(2)).length).toBe(2)
  })

  it("trims oldest beyond the cap on insert", async () => {
    // Insert cap + 3; the 3 oldest should be evicted.
    for (let i = 0; i < INBOUND_DRAFTS_CAP + 3; i++) {
      await addInboundDraft(draft(`d${i}`, i))
    }
    expect(await getDb().inboundDrafts.count()).toBe(INBOUND_DRAFTS_CAP)
    expect(await getInboundDraft("d0")).toBeUndefined()
    expect(await getInboundDraft("d2")).toBeUndefined()
    expect(await getInboundDraft("d3")).toBeDefined()
  }, 30_000)
})
