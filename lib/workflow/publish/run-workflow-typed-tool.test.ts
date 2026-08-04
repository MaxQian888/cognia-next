import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createWorkflow, updateWorkflow } from "@/lib/db/workflows"
import { executeRunWorkflowTyped } from "./run-workflow-typed-tool"
import { publishWorkflow } from "./publish-workflow"

// Overridable passthrough so the catch-all branch can be exercised — ESM
// namespaces reject spyOn redefinition.
let lookupOverride: (() => Promise<never>) | null = null
jest.mock("@/lib/workflow/library/lookup", () => {
  const actual = jest.requireActual("@/lib/workflow/library/lookup")
  return {
    ...actual,
    resolveWorkflowByNameOrId: (name: string) =>
      lookupOverride ? lookupOverride() : actual.resolveWorkflowByNameOrId(name),
  }
})

afterEach(() => {
  lookupOverride = null
})

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

const inputSchema = {
  type: "object",
  properties: { topic: { type: "string" } },
  required: ["topic"],
}

async function seedPublished(
  name: string,
  opts: { outputSchema?: Record<string, unknown> } = {}
): Promise<string> {
  const wf = await createWorkflow({
    name,
    nodes: [
      {
        id: "n_start",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "start", params: { inputSchema } },
      },
    ],
    edges: [],
  })
  await publishWorkflow(wf.id, 1)
  // This fixture targets the runner's final output guard rather than the
  // io.output node's own schema validation, so inject the stored contract
  // directly after the canonical publish path has established publication.
  if (opts.outputSchema) {
    await getDb().workflows.update(wf.id, {
      interface: { inputSchema, outputSchema: opts.outputSchema },
    })
  }
  return wf.id
}

describe("executeRunWorkflowTyped", () => {
  it("requires a name", async () => {
    const r = await executeRunWorkflowTyped({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("invalid-name")
  })

  it("reports not-found for an unknown workflow", async () => {
    const r = await executeRunWorkflowTyped({ name: "ghost" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("workflow-not-found")
  })

  it("rejects an unpublished workflow", async () => {
    await createWorkflow({
      name: "Draft",
      nodes: [
        {
          id: "n",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "s", params: {} },
        },
      ],
      edges: [],
    })
    const r = await executeRunWorkflowTyped({ name: "Draft" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not-published")
  })

  it("rejects input that violates the declared schema", async () => {
    await seedPublished("Summarizer")
    const r = await executeRunWorkflowTyped({ name: "Summarizer", input: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("input-schema-violation")
  })

  it("runs a published workflow with conforming input", async () => {
    await seedPublished("Summarizer")
    const r = await executeRunWorkflowTyped({ name: "Summarizer", input: { topic: "ai" } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.workflowName).toBe("Summarizer")
      expect(typeof r.runId).toBe("string")
    }
  })

  it("reports output-schema-violation when the run output misses the contract", async () => {
    // The single trigger node yields no `summary` field, so a required output
    // schema must fail AFTER a successful run.
    await seedPublished("Contract", {
      outputSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    })
    const r = await executeRunWorkflowTyped({ name: "Contract", input: { topic: "ai" } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("output-schema-violation")
  })

  it("reports workflow-ambiguous with candidate bullets when a name matches twice", async () => {
    await seedPublished("Twin")
    await seedPublished("twin")
    const r = await executeRunWorkflowTyped({ name: "TWIN" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("workflow-ambiguous")
      expect(r.error.message).toContain("1.")
      expect(r.error.message).toContain("2.")
    }
  })

  it("reports run-failed when the published graph fails to run", async () => {
    const id = await seedPublished("Broken")
    // Corrupt the graph AFTER publishing: a dangling edge fails validation at
    // run time, so the runner surfaces run-failed instead of throwing.
    await updateWorkflow(id, {
      edges: [{ id: "e_ghost", source: "n_start", target: "n_missing" }],
    })
    const r = await executeRunWorkflowTyped({ name: "Broken", input: { topic: "x" } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("run-failed")
      expect(r.error.message).toMatch(/Invalid workflow/)
    }
  })

  it("collapses unexpected throws into a structured error", async () => {
    lookupOverride = () => Promise.reject(new Error("boom"))
    const r = await executeRunWorkflowTyped({ name: "anything" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("tool-execution-failed")
      expect(r.error.message).toBe("boom")
    }
  })
})
