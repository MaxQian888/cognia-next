/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createWorkflow } from "@/lib/db/workflows"
import { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"
import { buildRunTypedTools } from "./run-typed-tools"

const tool = buildRunTypedTools().find((t) => t.name === "wf_run_workflow_typed")!

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

const inputSchema = {
  type: "object",
  properties: { topic: { type: "string" } },
  required: ["topic"],
}

async function seedPublished(name: string): Promise<string> {
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
  return wf.id
}

const exec = (args: Record<string, unknown>) => tool.execute(args, { config: {} } as never)

describe("wf_run_workflow_typed", () => {
  it("requires a name", async () => {
    const r = (await exec({})) as { ok: boolean; error: { code: string } }
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("invalid-name")
  })

  it("reports not-found for an unknown workflow", async () => {
    const r = (await exec({ name: "ghost" })) as { ok: boolean; error: { code: string } }
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("workflow-not-found")
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
    const r = (await exec({ name: "Draft" })) as { ok: boolean; error: { code: string } }
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("not-published")
  })

  it("rejects input that violates the declared schema", async () => {
    await seedPublished("Summarizer")
    const r = (await exec({ name: "Summarizer", input: {} })) as {
      ok: boolean
      error: { code: string }
    }
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("input-schema-violation")
  })

  it("runs a published workflow with conforming input", async () => {
    await seedPublished("Summarizer")
    const r = (await exec({ name: "Summarizer", input: { topic: "ai" } })) as {
      ok: boolean
      runId?: string
      workflowName?: string
    }
    expect(r.ok).toBe(true)
    expect(r.workflowName).toBe("Summarizer")
    expect(typeof r.runId).toBe("string")
  })
})
