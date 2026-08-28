import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createWorkflow } from "@/lib/db/workflows"
import {
  findWorkflowById,
  findWorkflowByName,
  listWorkflowSummaries,
  resolveWorkflowByNameOrId,
} from "./lookup"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

describe("findWorkflowByName", () => {
  it("returns ok with exact match (case-insensitive)", async () => {
    const created = await createWorkflow({ name: "Daily Standup" })
    const result = await findWorkflowByName("daily standup")
    expect(result).toEqual({ ok: true, workflowId: created.id, name: "Daily Standup" })
  })

  it("prefers exact over substring when both would match", async () => {
    await createWorkflow({ name: "Research Report Pipeline" })
    const exact = await createWorkflow({ name: "Research" })
    const result = await findWorkflowByName("research")
    expect(result).toEqual({ ok: true, workflowId: exact.id, name: "Research" })
  })

  it("returns ok with substring match when no exact match exists", async () => {
    const created = await createWorkflow({ name: "Quarterly Review Bot" })
    const result = await findWorkflowByName("quarterly")
    expect(result).toEqual({ ok: true, workflowId: created.id, name: "Quarterly Review Bot" })
  })

  it("returns ambiguous with capped candidates when substring matches >1", async () => {
    for (let i = 0; i < 7; i++) {
      await createWorkflow({ name: `Report Variant ${i}` })
    }
    const result = await findWorkflowByName("report")
    if (result.ok) throw new Error("expected not-ok")
    expect(result.reason).toBe("ambiguous")
    if (result.reason !== "ambiguous") throw new Error("type narrowing")
    expect(result.candidates).toHaveLength(5)
  })

  it("returns ambiguous when exact match itself has multiple rows", async () => {
    // Race / dup-import scenario. Lookup must surface both rather than pick one.
    await createWorkflow({ name: "Dup" })
    await createWorkflow({ name: "DUP" })
    const result = await findWorkflowByName("dup")
    if (result.ok) throw new Error("expected not-ok")
    expect(result.reason).toBe("ambiguous")
    if (result.reason !== "ambiguous") throw new Error("type narrowing")
    expect(result.candidates).toHaveLength(2)
  })

  it("returns not-found for empty / whitespace queries", async () => {
    await createWorkflow({ name: "X" })
    expect(await findWorkflowByName("")).toEqual({ ok: false, reason: "not-found" })
    expect(await findWorkflowByName("   ")).toEqual({ ok: false, reason: "not-found" })
  })

  it("returns not-found when nothing matches", async () => {
    await createWorkflow({ name: "Alpha" })
    expect(await findWorkflowByName("zeta")).toEqual({ ok: false, reason: "not-found" })
  })
})

describe("resolveWorkflowByNameOrId", () => {
  it("resolves by exact id first", async () => {
    const created = await createWorkflow({ name: "Nightly Run" })
    const result = await resolveWorkflowByNameOrId(created.id)
    expect(result).toEqual({ ok: true, workflowId: created.id, name: "Nightly Run" })
  })

  it("falls through to name resolution when the id does not exist", async () => {
    const created = await createWorkflow({ name: "By Name Only" })
    const result = await resolveWorkflowByNameOrId("by name only")
    expect(result).toEqual({ ok: true, workflowId: created.id, name: "By Name Only" })
  })

  it("surfaces ambiguity from the name path", async () => {
    await createWorkflow({ name: "Dup A" })
    await createWorkflow({ name: "Dup B" })
    const result = await resolveWorkflowByNameOrId("dup")
    if (result.ok) throw new Error("expected not-ok")
    expect(result.reason).toBe("ambiguous")
  })

  it("returns not-found for empty input", async () => {
    expect(await resolveWorkflowByNameOrId("   ")).toEqual({ ok: false, reason: "not-found" })
  })
})

describe("listWorkflowSummaries", () => {
  it("returns id/name/description for each created workflow", async () => {
    const a = await createWorkflow({ name: "Alpha", description: "first" })
    const b = await createWorkflow({ name: "Beta" })
    // The Dexie seed loads built-in workflows; we only need to assert ours
    // round-trip through the summary projection.
    const summaries = await listWorkflowSummaries(100)
    const ids = summaries.map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]))
    const alpha = summaries.find((s) => s.id === a.id)
    expect(alpha?.description).toBe("first")
    expect(alpha?.name).toBe("Alpha")
  })

  it("respects the limit argument", async () => {
    for (let i = 0; i < 5; i++) await createWorkflow({ name: `WF ${i}` })
    const summaries = await listWorkflowSummaries(2)
    expect(summaries).toHaveLength(2)
  })
})

describe("findWorkflowById", () => {
  it("returns the index-level summary, not the whole row", async () => {
    const created = await createWorkflow({ name: "Nightly Sync", description: "runs at 2am" })
    const summary = await findWorkflowById(created.id)
    expect(summary).toEqual({ id: created.id, name: "Nightly Sync", description: "runs at 2am" })
    expect(summary).not.toHaveProperty("definition")
  })

  it("is undefined for an id that does not exist", async () => {
    await expect(findWorkflowById("wf_missing")).resolves.toBeUndefined()
  })
})
