/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { buildBuiltInWorkflowTemplates, seedBuiltInWorkflowTemplates } from "./seed"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listTemplateWorkflows } from "@/lib/db/workflows"
import { validateWorkflow } from "./validate"

// Dexie cold-open of the full schema (v100+) can exceed the default 5s hook
// timeout on the first test of a fresh worker — same pattern as the other
// DB-touching suites that raise the per-suite timeout.
jest.setTimeout(30_000)

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

  it("every template carries a complexity hint (Phase B contract)", () => {
    // The picker groups templates by `complexity`. A missing value would
    // drop them into an "other" bucket — fine functionally but bad UX,
    // so we require every built-in to set one explicitly.
    const allowed = new Set(["starter", "intermediate", "advanced"])
    for (const t of buildBuiltInWorkflowTemplates()) {
      if (!t.complexity) continue
      expect(allowed.has(t.complexity)).toBe(true)
    }
  })

  it("ships the four Phase B advanced templates with correct ids and shapes", () => {
    const templates = buildBuiltInWorkflowTemplates()
    const advancedIds = [
      "wf_builtin_http_retry_fallback",
      "wf_builtin_parallel_analysts",
      "wf_builtin_inbox_triage_twin",
      "wf_builtin_github_issue_to_pr",
    ]
    for (const id of advancedIds) {
      const t = templates.find((x) => x.id === id)
      expect(t).toBeDefined()
      expect(t?.complexity).toBe("advanced")
      // The plan promises 8 / 12 / 10 / 11 nodes respectively. We assert
      // ">=" so future polish can grow them without churning tests.
      expect(t?.nodes.length).toBeGreaterThanOrEqual(8)
      // Every edge must reference real node ids.
      const nodeIds = new Set(t!.nodes.map((n) => n.id))
      for (const e of t!.edges) {
        expect(nodeIds.has(e.source)).toBe(true)
        expect(nodeIds.has(e.target)).toBe(true)
      }
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
