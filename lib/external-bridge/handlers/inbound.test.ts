import {
  recordLesson,
  saveSkillDraft,
  ingestNote,
  MAX_INBOUND_BODY_CHARS,
  MAX_INBOUND_TITLE_CHARS,
} from "./inbound"
import { addInboundDraft } from "@/lib/db/inbound-drafts"

jest.mock("@/lib/db/inbound-drafts", () => ({
  addInboundDraft: jest.fn(async () => {}),
}))

const mockedAdd = addInboundDraft as jest.MockedFunction<typeof addInboundDraft>

beforeEach(() => {
  mockedAdd.mockClear()
})

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
    })
    const row = mockedAdd.mock.calls[0][0]
    expect(row.kind).toBe("lesson")
    expect(row.status).toBe("pending")
    expect(row.title).toBe("Prefer pnpm")
    expect(row.body).toBe(
      "<untrusted_content>\nAlways install from repo root.\n</untrusted_content>"
    )
    expect(row.metadata).toEqual({ tags: ["build", "pnpm"] })
    expect(row.source).toBe("claude-code")
    expect(typeof row.createdAt).toBe("number")
  })

  it("record_lesson omits empty tag metadata", async () => {
    await recordLesson({ title: "t", lesson: "l", tags: ["", "  "] })
    expect(mockedAdd.mock.calls[0][0].metadata).toBeUndefined()
  })

  it("save_skill_draft carries description + trigger metadata", async () => {
    const res = await saveSkillDraft({
      name: "deploy",
      instructions: "Run the deploy script.",
      description: "Ship it",
      trigger: "deploy the app",
    })
    expect(res.kind).toBe("skill")
    const row = mockedAdd.mock.calls[0][0]
    expect(row.kind).toBe("skill")
    expect(row.title).toBe("deploy")
    expect(row.metadata).toEqual({ description: "Ship it", trigger: "deploy the app" })
  })

  it("save_skill_draft omits metadata when neither optional is given", async () => {
    await saveSkillDraft({ name: "n", instructions: "i" })
    expect(mockedAdd.mock.calls[0][0].metadata).toBeUndefined()
  })

  it("ingest_note carries url metadata when present", async () => {
    await ingestNote({ title: "note", note: "body", url: "https://x/y" })
    const row = mockedAdd.mock.calls[0][0]
    expect(row.kind).toBe("note")
    expect(row.metadata).toEqual({ url: "https://x/y" })

    await ingestNote({ title: "note2", note: "body2" })
    expect(mockedAdd.mock.calls[1][0].metadata).toBeUndefined()
  })

  it("rejects empty required fields", async () => {
    await expect(recordLesson({ title: "  ", lesson: "x" })).rejects.toThrow(/title/)
    await expect(recordLesson({ title: "t", lesson: "" })).rejects.toThrow(/lesson/)
    await expect(saveSkillDraft({ name: "", instructions: "x" })).rejects.toThrow(/name/)
    await expect(saveSkillDraft({ name: "n", instructions: " " })).rejects.toThrow(/instructions/)
    await expect(ingestNote({ title: "", note: "x" })).rejects.toThrow(/title/)
    await expect(ingestNote({ title: "t", note: "" })).rejects.toThrow(/note/)
    expect(mockedAdd).not.toHaveBeenCalled()
  })

  it("rejects an over-long body", async () => {
    const big = "x".repeat(MAX_INBOUND_BODY_CHARS + 1)
    await expect(recordLesson({ title: "t", lesson: big })).rejects.toThrow(/exceeds/)
  })

  it("rejects an over-long title", async () => {
    const longTitle = "t".repeat(MAX_INBOUND_TITLE_CHARS + 50)
    await expect(ingestNote({ title: longTitle, note: "body" })).rejects.toThrow(/exceeds/)
    expect(mockedAdd).not.toHaveBeenCalled()
  })
})
