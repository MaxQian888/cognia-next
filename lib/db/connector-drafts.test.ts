/**
 * Tests for lib/db/connector-drafts.ts — outbound draft approval queue.
 */

import {
  createDraft,
  listPendingForConversation,
  approveDraft,
  rejectDraft,
  sweepExpired,
} from "./connector-drafts"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import type { MessageSegment } from "@/types/connectors/segment"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const segments: MessageSegment[] = [{ type: "text", text: "Hello!" }]

function baseInput() {
  return {
    conversationKey: "telegram:adp_1:chat_1",
    sessionId: "sess_abc",
    segments,
  }
}

describe("connector-drafts", () => {
  it("createDraft creates a pending row with generated id", async () => {
    const draft = await createDraft(baseInput())
    expect(draft.id).toMatch(/^cdr_/)
    expect(draft.status).toBe("pending")
    expect(draft.conversationKey).toBe("telegram:adp_1:chat_1")
    expect(draft.segments).toEqual(segments)
    expect(draft.createdAt).toBeGreaterThan(0)
  })

  it("createDraft stores optional fields (sourceMessageId, expiresAt)", async () => {
    const draft = await createDraft({
      ...baseInput(),
      sourceMessageId: "src_msg_1",
      expiresAt: Date.now() + 60_000,
    })
    expect(draft.sourceMessageId).toBe("src_msg_1")
    expect(draft.expiresAt).toBeGreaterThan(Date.now())
  })

  it("listPendingForConversation returns pending drafts in createdAt asc order", async () => {
    const d1 = await createDraft(baseInput())
    await new Promise((r) => setTimeout(r, 1))
    const d2 = await createDraft(baseInput())
    await new Promise((r) => setTimeout(r, 1))
    const d3 = await createDraft(baseInput())
    const pending = await listPendingForConversation("telegram:adp_1:chat_1")
    expect(pending.map((d) => d.id)).toEqual([d1.id, d2.id, d3.id])
  })

  it("listPendingForConversation excludes approved/rejected/expired drafts", async () => {
    const d1 = await createDraft(baseInput())
    const d2 = await createDraft(baseInput())
    await approveDraft(d1.id)
    const pending = await listPendingForConversation("telegram:adp_1:chat_1")
    expect(pending.map((d) => d.id)).toEqual([d2.id])
  })

  it("approveDraft sets status to approved", async () => {
    const draft = await createDraft(baseInput())
    await approveDraft(draft.id)
    const updated = await getDb().connectorDrafts.get(draft.id)
    expect(updated?.status).toBe("approved")
  })

  it("rejectDraft sets status to rejected", async () => {
    const draft = await createDraft(baseInput())
    await rejectDraft(draft.id)
    const updated = await getDb().connectorDrafts.get(draft.id)
    expect(updated?.status).toBe("rejected")
  })

  it("sweepExpired sets status=expired for past-expiresAt pending rows and returns count", async () => {
    const pastAt = Date.now() - 1000
    const futureAt = Date.now() + 60_000
    const d1 = await createDraft({ ...baseInput(), expiresAt: pastAt })
    const d2 = await createDraft({ ...baseInput(), expiresAt: futureAt })
    const d3 = await createDraft(baseInput()) // no expiresAt
    const count = await sweepExpired()
    expect(count).toBe(1)
    const updated1 = await getDb().connectorDrafts.get(d1.id)
    const updated2 = await getDb().connectorDrafts.get(d2.id)
    const updated3 = await getDb().connectorDrafts.get(d3.id)
    expect(updated1?.status).toBe("expired")
    expect(updated2?.status).toBe("pending")
    expect(updated3?.status).toBe("pending")
  })

  it("sweepExpired returns 0 when nothing has expired", async () => {
    await createDraft(baseInput())
    const count = await sweepExpired()
    expect(count).toBe(0)
  })

  it("sweepExpired does not expire already-approved drafts", async () => {
    const pastAt = Date.now() - 1000
    const draft = await createDraft({ ...baseInput(), expiresAt: pastAt })
    await approveDraft(draft.id)
    const count = await sweepExpired()
    expect(count).toBe(0)
    const updated = await getDb().connectorDrafts.get(draft.id)
    expect(updated?.status).toBe("approved")
  })

  describe("workspace (project) scoping", () => {
    it("stamps a draft with the session's projectId", async () => {
      await getDb().sessions.put({
        id: "sess_abc",
        projectId: "proj-A",
        title: "a",
        updatedAt: 1,
        createdAt: 1,
      } as never)
      const draft = await createDraft(baseInput())
      expect(draft.projectId).toBe("proj-A")
    })
  })
})
