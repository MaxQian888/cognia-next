/** @jest-environment jsdom */
import "fake-indexeddb/auto"

const storeExternalMemory = jest.fn()
jest.mock("@/lib/memory/api/store-memory", () => ({
  storeExternalMemory: (...args: unknown[]) => storeExternalMemory(...args),
}))

import {
  CONSOLIDATED_INTO_EXISTING,
  materializeDraft,
  retryMaterializationNow,
  runMaterializationPass,
} from "./materializer"
import { acceptInboundDraft, addInboundDraft, type InboundDraftRow } from "@/lib/db/inbound-drafts"
import {
  enqueueInboundMaterialization,
  getInboundMaterialization,
} from "@/lib/db/inbound-materializations"
import { findKnowledgeNoteBySourceDraft } from "@/lib/db/knowledge-notes"
import { listSkills } from "@/lib/db/skills"
import { wrapUntrusted } from "@/lib/external-bridge/untrusted"
import { getDb } from "@/lib/db/schema"

function draft(id: string, overrides: Partial<InboundDraftRow> = {}): InboundDraftRow {
  return {
    id,
    kind: "note",
    status: "pending",
    title: `title-${id}`,
    body: wrapUntrusted(`body-${id}`),
    createdAt: 1000,
    ...overrides,
  }
}

/** Seed an accepted draft with its outbox row, the way the review UI would. */
async function seedAccepted(row: InboundDraftRow): Promise<void> {
  await addInboundDraft(row)
  await acceptInboundDraft(row.id)
}

beforeEach(async () => {
  const db = getDb()
  await db.inboundDrafts.clear()
  await db.inboundMaterializations.clear()
  await db.knowledgeNotes.clear()
  await db.skills.clear()
  storeExternalMemory.mockReset()
  storeExternalMemory.mockResolvedValue({
    ok: true,
    stored: true,
    consolidated: false,
    memoryId: "mem_1",
    applied: ["ADD"],
  })
}, 30_000)

describe("note materialization", () => {
  it("creates a knowledge note keeping the untrusted envelope", async () => {
    await seedAccepted(draft("d1", { kind: "note", metadata: { url: "https://x.test" } }))

    const [result] = await runMaterializationPass()

    expect(result).toMatchObject({ draftId: "d1", status: "completed" })
    const note = await findKnowledgeNoteBySourceDraft("d1")
    // A note is fed back to models as external content; the envelope is what
    // marks it as such.
    expect(note?.body).toContain("<untrusted_content>")
    expect(note?.url).toBe("https://x.test")
    expect(await getInboundMaterialization("d1")).toMatchObject({
      status: "completed",
      producedId: note!.id,
    })
  })

  it("is idempotent — a replayed job reuses the existing note", async () => {
    await seedAccepted(draft("d1", { kind: "note" }))
    await runMaterializationPass()
    const first = await findKnowledgeNoteBySourceDraft("d1")

    await enqueueInboundMaterialization("d1", "note")
    await runMaterializationPass()

    expect(await getDb().knowledgeNotes.count()).toBe(1)
    expect((await findKnowledgeNoteBySourceDraft("d1"))?.id).toBe(first!.id)
  })
})

describe("skill materialization", () => {
  it("creates the skill DISABLED", async () => {
    await seedAccepted(
      draft("d1", { kind: "skill", title: "Deploy runbook", metadata: { description: "how to" } })
    )

    await runMaterializationPass()

    const skills = await listSkills()
    expect(skills).toHaveLength(1)
    // Accepting a draft means "worth keeping", never "may now act on my
    // behalf" — an external agent must not write the assistant's instructions.
    expect(skills[0].status).toBe("disabled")
    expect(skills[0].name).toBe("Deploy runbook")
    expect(skills[0].description).toBe("how to")
    // The envelope is stripped for skill content: it becomes instructions the
    // user reads and edits, not model-facing external text.
    expect(skills[0].content).not.toContain("<untrusted_content>")
  })

  it("is idempotent via canonicalId — a retry does not create a second skill", async () => {
    await seedAccepted(draft("d1", { kind: "skill" }))
    await runMaterializationPass()

    await enqueueInboundMaterialization("d1", "skill")
    await runMaterializationPass()

    expect(await listSkills()).toHaveLength(1)
  })
})

describe("lesson materialization", () => {
  it("routes through storeExternalMemory as a semantic memory", async () => {
    await seedAccepted(draft("d1", { kind: "lesson", metadata: { tags: ["rust", 7] } }))

    const [result] = await runMaterializationPass()

    expect(result).toMatchObject({ status: "completed", producedId: "mem_1" })
    expect(storeExternalMemory).toHaveBeenCalledWith(
      // Envelope stripped: the memory subsystem applies its own fencing on
      // retrieval, and a doubly-fenced body renders as literal tag text.
      expect.objectContaining({ text: "body-d1", type: "semantic", tags: ["rust"] }),
      { channel: "mcp" }
    )
  })

  it("treats a consolidated memory as success, not a retryable failure", async () => {
    storeExternalMemory.mockResolvedValue({
      ok: true,
      stored: false,
      consolidated: true,
      applied: ["NOOP"],
    })
    await seedAccepted(draft("d1", { kind: "lesson" }))

    const [result] = await runMaterializationPass()

    expect(result).toMatchObject({ status: "completed", producedId: CONSOLIDATED_INTO_EXISTING })
  })

  it("surfaces the refusal reason so the UI can distinguish causes", async () => {
    storeExternalMemory.mockResolvedValue({ ok: false, reason: "pii_blocked" })
    await seedAccepted(draft("d1", { kind: "lesson" }))

    const [result] = await runMaterializationPass()

    expect(result.status).toBe("failed")
    expect(result.error).toContain("pii_blocked")
    // The review decision stands; only the job failed.
    expect((await getDb().inboundDrafts.get("d1"))?.status).toBe("accepted")
    expect(await getInboundMaterialization("d1")).toMatchObject({ status: "failed" })
  })
})

describe("worker safety", () => {
  it("refuses to materialize a draft that is not accepted", async () => {
    // Defence in depth: a queue row for a pending draft is an upstream bug,
    // and acting on it would apply content the operator never approved.
    await addInboundDraft(draft("d1", { kind: "note" }))
    await enqueueInboundMaterialization("d1", "note")

    const [result] = await runMaterializationPass()

    expect(result).toMatchObject({ status: "failed" })
    expect(result.error).toContain("pending")
    expect(await getDb().knowledgeNotes.count()).toBe(0)
  })

  it("fails the job when the source draft has been evicted", async () => {
    await enqueueInboundMaterialization("ghost", "note")

    const [result] = await runMaterializationPass()

    expect(result.error).toBe("source draft no longer exists")
  })

  it("one poisonous draft does not stall the queue behind it", async () => {
    storeExternalMemory.mockResolvedValue({ ok: false, reason: "disabled" })
    await seedAccepted(draft("bad", { kind: "lesson", createdAt: 1 }))
    await seedAccepted(draft("good", { kind: "note", createdAt: 2 }))

    const results = await runMaterializationPass()

    expect(results.map((r) => r.status).sort()).toEqual(["completed", "failed"])
    expect(await findKnowledgeNoteBySourceDraft("good")).toBeDefined()
  })

  it("honours the pass limit", async () => {
    for (let i = 0; i < 4; i++) {
      await seedAccepted(draft(`d${i}`, { kind: "note", createdAt: i }))
    }
    expect(await runMaterializationPass(2)).toHaveLength(2)
  })
})

describe("single-draft retry", () => {
  it("re-runs one previously failed job", async () => {
    storeExternalMemory.mockResolvedValue({ ok: false, reason: "temporary" })
    await seedAccepted(draft("d1", { kind: "lesson" }))
    await runMaterializationPass()

    storeExternalMemory.mockResolvedValue({
      ok: true,
      stored: true,
      consolidated: false,
      memoryId: "mem_9",
      applied: ["ADD"],
    })
    const result = await retryMaterializationNow("d1")

    expect(result).toMatchObject({ status: "completed", producedId: "mem_9" })
  })

  it("reports a draft with nothing queued rather than inventing a job", async () => {
    expect(await retryMaterializationNow("nothing")).toMatchObject({
      status: "skipped",
      error: "no materialization queued",
    })
  })
})

describe("materializeDraft", () => {
  it("dispatches on kind", async () => {
    await expect(materializeDraft(draft("d1", { kind: "note" }))).resolves.toBe("kn_d1")
  })
})
