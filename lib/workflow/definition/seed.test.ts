/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { buildBuiltInWorkflowTemplates, seedBuiltInWorkflowTemplates } from "./seed"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listTemplateWorkflows } from "@/lib/db/workflows"
import { validateWorkflow } from "./validate"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("buildBuiltInWorkflowTemplates", () => {
  it("returns at least 4 templates", () => {
    expect(buildBuiltInWorkflowTemplates().length).toBeGreaterThanOrEqual(4)
  })

  it("uses stable surrogate ids for every template (so reseed is idempotent)", () => {
    const a = buildBuiltInWorkflowTemplates().map((t) => t.id)
    const b = buildBuiltInWorkflowTemplates().map((t) => t.id)
    expect(a).toEqual(b)
    // No duplicates within one call.
    expect(new Set(a).size).toBe(a.length)
  })

  it("marks every template as isBuiltIn AND isTemplate", () => {
    for (const t of buildBuiltInWorkflowTemplates()) {
      expect(t.isBuiltIn).toBe(true)
      expect(t.isTemplate).toBe(true)
    }
  })

  it("every template passes the workflow validator", () => {
    for (const t of buildBuiltInWorkflowTemplates()) {
      const result = validateWorkflow(t)
      if (!result.ok) {
        throw new Error(`Template ${t.id} is invalid: ${result.errors.join("; ")}`)
      }
    }
  })

  it("every template has at least one trigger node", () => {
    for (const t of buildBuiltInWorkflowTemplates()) {
      expect(t.nodes.some((n) => n.type.startsWith("trigger."))).toBe(true)
    }
  })
})

describe("seedBuiltInWorkflowTemplates", () => {
  it("inserts every built-in template into Dexie", async () => {
    const expected = buildBuiltInWorkflowTemplates().length
    const written = await seedBuiltInWorkflowTemplates()
    expect(written).toBe(expected)
    const stored = await listTemplateWorkflows()
    expect(stored.length).toBeGreaterThanOrEqual(expected)
    expect(stored.every((w) => w.isBuiltIn && w.isTemplate)).toBe(true)
  })

  it("is idempotent — repeat calls don't create duplicates", async () => {
    await seedBuiltInWorkflowTemplates()
    await seedBuiltInWorkflowTemplates()
    const stored = await listTemplateWorkflows()
    const ids = stored.map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("preserves isBuiltIn=true even if a previous run cleared the flag", async () => {
    await seedBuiltInWorkflowTemplates()
    // Simulate a row that lost the isBuiltIn flag (e.g., during a manual edit).
    const all = await listTemplateWorkflows()
    const sample = all[0]
    await getDb().workflows.update(sample.id, { isBuiltIn: false })
    // Re-seed should re-stamp it.
    await seedBuiltInWorkflowTemplates()
    const after = await getDb().workflows.get(sample.id)
    expect(after?.isBuiltIn).toBe(true)
  })
})
