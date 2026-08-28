import { createDbTestFixture } from "@cognia/plugin-sdk/api/testing"
import { createWorkflow, publishWorkflow } from "@cognia/plugin-sdk/api/workflow-run"
import { buildRunTypedTools } from "./run-typed-tools"

const tool = buildRunTypedTools().find((t) => t.name === "wf_run_workflow_typed")!

// Use the shared fixture rather than a per-test delete()+reopen. This suite is
// the only one in this directory that drives a REAL run through
// `executeDeployedWorkflow`, and tearing the Dexie database down underneath it
// aborted the admission transaction (TransactionInactiveError). The fixture
// snapshots and restores instead, holding one connection open for the whole
// file — the same setup `lib/workflow/runtime/execution-authority.test.ts`
// uses to drive the same executor.
//
// The fixture also owns the Dexie runtime (`__enableDbRuntimeForTesting`), so
// this file runs in the default node env: the `@jest-environment jsdom`
// docblock the old hand-rolled setup needed is gone. Both halves are load
// bearing — keeping the docblock with the fixture fails the whole suite.
const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

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
