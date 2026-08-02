/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  addInboundDraft,
  getInboundDraft,
  listInboundDrafts,
  listPendingInboundDrafts,
  acceptInboundDraft,
  rejectInboundDraft,
  materializableBody,
  deleteInboundDraft,
  InboundDraftTransitionError,
  INBOUND_DRAFTS_CAP,
  type InboundDraftRow,
} from "./inbound-drafts"
import { getInboundMaterialization } from "./inbound-materializations"
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
  await getDb().inboundMaterializations.clear()
}, 30_000)

describe("inbound-drafts CRUD", () => {
  it("adds, reads, and deletes", async () => {
    await addInboundDraft(draft("a", 1000))
    expect((await getInboundDraft("a"))?.title).toBe("a")

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

describe("review state machine (v142)", () => {
  it("accept flips status and enqueues materialization atomically", async () => {
    await addInboundDraft(draft("a", 1000, { kind: "note" }))

    const accepted = await acceptInboundDraft("a", { now: 4242 })

    expect(accepted.status).toBe("accepted")
    expect(accepted.reviewedAt).toBe(4242)
    // The whole point of the shared transaction: an accepted draft always has
    // a queue row to materialize from.
    const queued = await getInboundMaterialization("a")
    expect(queued).toMatchObject({ draftId: "a", kind: "note", status: "queued", attempts: 0 })
  })

  it("reject is terminal and enqueues nothing", async () => {
    await addInboundDraft(draft("r", 1000))

    const rejected = await rejectInboundDraft("r", { reason: "spam", now: 77 })

    expect(rejected.status).toBe("rejected")
    expect(rejected.rejectionReason).toBe("spam")
    expect(rejected.reviewedAt).toBe(77)
    expect(await getInboundMaterialization("r")).toBeUndefined()
  })

  it("refuses to transition out of a terminal state", async () => {
    await addInboundDraft(draft("t", 1000))
    await acceptInboundDraft("t")

    await expect(acceptInboundDraft("t")).rejects.toThrow(InboundDraftTransitionError)
    await expect(rejectInboundDraft("t")).rejects.toThrow(/accepted → rejected/)

    // The losing call must not have disturbed the winner's row.
    expect((await getInboundDraft("t"))?.status).toBe("accepted")
  })

  it("a second concurrent accept loses the CAS and leaves one queue row", async () => {
    await addInboundDraft(draft("race", 1000))

    const results = await Promise.allSettled([
      acceptInboundDraft("race"),
      acceptInboundDraft("race"),
    ])

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
    expect(await getDb().inboundMaterializations.count()).toBe(1)
  })

  it("rejects a transition on a missing draft rather than creating one", async () => {
    await expect(acceptInboundDraft("ghost")).rejects.toThrow(/missing → accepted/)
    expect(await getDb().inboundMaterializations.count()).toBe(0)
  })

  it("materializableBody prefers the operator's edit but keeps it wrapped", async () => {
    const original = draft("e", 1000)
    expect(materializableBody(original)).toBe(original.body)

    await addInboundDraft(original)
    const edited = await acceptInboundDraft("e", {
      editedBody: "<untrusted_content>\ntrimmed\n</untrusted_content>",
    })

    expect(materializableBody(edited)).toContain("trimmed")
    expect(materializableBody(edited)).toContain("<untrusted_content>")
  })
})
