/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  recordLesson,
  saveSkillDraft,
  ingestNote,
  MAX_INBOUND_BODY_CHARS,
  MAX_INBOUND_TITLE_CHARS,
} from "./inbound"
import { getInboundDraft } from "@/lib/db/inbound-drafts"
import { getDb } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().inboundDrafts.clear()
}, 30_000)

async function onlyDraft() {
  const rows = await getDb().inboundDrafts.toArray()
  expect(rows).toHaveLength(1)
  return rows[0]
}

describe("inbound write handlers", () => {
  it("record_lesson persists a pending, untrusted-wrapped lesson draft", async () => {
    const res = await recordLesson({
      title: "  Prefer pnpm  ",
      lesson: "Always install from repo root.",
      tags: ["  build ", "", "pnpm"],
      source: "claude-code",
    })
    expect(res).toEqual({
      ok: true,
      draftId: expect.any(String),
      kind: "lesson",
      status: "pending",
      duplicate: false,
    })

    const row = await onlyDraft()
    expect(row.kind).toBe("lesson")
    expect(row.status).toBe("pending")
    expect(row.title).toBe("Prefer pnpm")
    expect(row.body).toBe(
      "<untrusted_content>\nAlways install from repo root.\n</untrusted_content>"
    )
    expect(row.metadata).toMatchObject({ tags: ["build", "pnpm"], origin: "mcp" })
    expect(row.source).toBe("claude-code")
    expect(typeof row.createdAt).toBe("number")
  })

  it("record_lesson omits empty tag metadata", async () => {
    await recordLesson({ title: "t", lesson: "l", tags: ["", "  "] })
    expect((await onlyDraft()).metadata).toEqual({ origin: "mcp" })
  })

  it("save_skill_draft carries description + trigger metadata", async () => {
    const res = await saveSkillDraft({
      name: "deploy",
      instructions: "Run the deploy script.",
      description: "Ship it",
      trigger: "deploy the app",
    })
    expect(res.kind).toBe("skill")

    const row = await onlyDraft()
    expect(row.kind).toBe("skill")
    expect(row.title).toBe("deploy")
    expect(row.metadata).toMatchObject({ description: "Ship it", trigger: "deploy the app" })
  })

  it("save_skill_draft omits metadata when neither optional is given", async () => {
    await saveSkillDraft({ name: "n", instructions: "i" })
    expect((await onlyDraft()).metadata).toEqual({ origin: "mcp" })
  })

  it("ingest_note carries url metadata when present", async () => {
    await ingestNote({ title: "note", note: "body", url: "https://x/y" })
    const first = await onlyDraft()
    expect(first.kind).toBe("note")
    expect(first.metadata).toMatchObject({ url: "https://x/y" })

    await ingestNote({ title: "note2", note: "body2" })
    const rows = await getDb().inboundDrafts.orderBy("createdAt").toArray()
    expect(rows[1].metadata).toEqual({ origin: "mcp" })
  })

  it("names the offending tool parameter in validation errors", async () => {
    // "body must not be empty" leaves the calling agent guessing which of its
    // arguments was wrong.
    await expect(recordLesson({ title: "  ", lesson: "x" })).rejects.toThrow(/title/)
    await expect(recordLesson({ title: "t", lesson: "" })).rejects.toThrow(/lesson/)
    await expect(saveSkillDraft({ name: "", instructions: "x" })).rejects.toThrow(/name/)
    await expect(saveSkillDraft({ name: "n", instructions: " " })).rejects.toThrow(/instructions/)
    await expect(ingestNote({ title: "", note: "x" })).rejects.toThrow(/title/)
    await expect(ingestNote({ title: "t", note: "" })).rejects.toThrow(/note/)
    expect(await getDb().inboundDrafts.count()).toBe(0)
  })

  it("rejects an over-long body", async () => {
    const big = "x".repeat(MAX_INBOUND_BODY_CHARS + 1)
    await expect(recordLesson({ title: "t", lesson: big })).rejects.toThrow(/exceeds/)
  })

  it("rejects an over-long title", async () => {
    const longTitle = "t".repeat(MAX_INBOUND_TITLE_CHARS + 50)
    await expect(ingestNote({ title: longTitle, note: "body" })).rejects.toThrow(/exceeds/)
    expect(await getDb().inboundDrafts.count()).toBe(0)
  })
})

describe("shared distiller pipeline", () => {
  it("reports a re-submission as a duplicate instead of queueing it twice", async () => {
    const first = await recordLesson({ title: "t", lesson: "same lesson" })
    const second = await recordLesson({ title: "t", lesson: "same   lesson" })

    expect(second).toEqual({
      ok: true,
      draftId: first.draftId,
      kind: "lesson",
      status: "pending",
      duplicate: true,
    })
    expect(await getDb().inboundDrafts.count()).toBe(1)
  })

  it("redacts PII out of a submission before it is stored", async () => {
    const res = await ingestNote({ title: "contact", note: "ping alice@example.com" })
    const row = await getInboundDraft(res.draftId)
    expect(row?.body).not.toContain("alice@example.com")
  })

  it("never calls a model for an MCP submission", async () => {
    // MCP input arrives already structured; classifying it would be an
    // unrequested outbound call on the user's account.
    const classify = jest.fn()
    await ingestNote({ title: "t", note: "n" }, { classifier: { classify } })
    expect(classify).not.toHaveBeenCalled()
  })
})
