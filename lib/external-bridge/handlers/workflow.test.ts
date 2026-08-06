import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createWorkflow, updateWorkflow } from "@/lib/db/workflows"
import { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"
import {
  cancelWorkflowRunCore,
  createWorkflowRunCore,
  getWorkflowRunCore,
  listWorkflowDeploymentsCore,
  listWorkflowEventsCore,
} from "./workflow"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const inputSchema = {
  type: "object",
  properties: { topic: { type: "string", description: "Topic to summarize" } },
  required: ["topic"],
}

function interfaceNodes() {
  return [
    {
      id: "start",
      type: "trigger.manual" as const,
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "Start", params: { inputSchema } },
    },
  ]
}

async function publishNamedWorkflow(name: string) {
  const workflow = await createWorkflow({ name, nodes: interfaceNodes(), edges: [] })
  const publication = await publishWorkflow(workflow.id, Date.now())
  return { workflow, publication }
}

describe("External Bridge workflow host adapter", () => {
  it("lists only active immutable deployments and does not project later draft edits", async () => {
    const { workflow, publication } = await publishNamedWorkflow("Summarize PRs")
    await updateWorkflow(workflow.id, { name: "Edited draft name" })

    const descriptors = await listWorkflowDeploymentsCore()

    expect(descriptors).toEqual([
      expect.objectContaining({
        deploymentId: publication.deploymentId,
        versionId: publication.versionId,
        workflowId: workflow.id,
        revision: 1,
        name: "Summarize PRs",
        toolName: "workflow_summarize_prs",
        inputSchema,
      }),
    ])

    await getDb().workflowDeployments.update(publication.deploymentId, { status: "disabled" })
    await expect(listWorkflowDeploymentsCore()).resolves.toEqual([])
  })

  it("keeps collision names stable when the original deployment is disabled", async () => {
    const left = await publishNamedWorkflow("Duplicate name")
    const right = await publishNamedWorkflow("Duplicate name")

    const first = await listWorkflowDeploymentsCore()
    const second = await listWorkflowDeploymentsCore()
    const names = first.map((descriptor) => descriptor.toolName)

    expect(first).toEqual(second)
    expect(new Set(names).size).toBe(2)
    expect(names.every((name) => /^workflow_duplicate_name_[0-9a-f]{8}$/.test(name))).toBe(true)
    expect(first.map((descriptor) => descriptor.deploymentId).sort()).toEqual(
      [left.publication.deploymentId, right.publication.deploymentId].sort()
    )

    const original = first[0]
    const survivor = first[1]

    await getDb().workflowDeployments.update(original.deploymentId, { status: "disabled" })
    await expect(listWorkflowDeploymentsCore()).resolves.toEqual([
      expect.objectContaining({
        deploymentId: survivor.deploymentId,
        toolName: survivor.toolName,
      }),
    ])
  })

  it("keeps deployment tools distinct from workflow lifecycle tool names", async () => {
    const { publication } = await publishNamedWorkflow("List")

    await expect(listWorkflowDeploymentsCore()).resolves.toEqual([
      expect.objectContaining({
        deploymentId: publication.deploymentId,
        toolName: expect.stringMatching(/^workflow_list_[0-9a-f]{8}$/),
      }),
    ])
  })

  it("reuses the canonical run, status, event, and cancel services with MCP provenance", async () => {
    const { publication } = await publishNamedWorkflow("MCP execution")
    const accepted = await createWorkflowRunCore({
      deploymentId: publication.deploymentId,
      caller: "mcp:client-7",
      idempotencyKey: "mcp-call-1",
      input: { topic: "release" },
    })

    const run = await getDb().workflowRuns.get(accepted.runId)
    expect(run?.executionBinding).toMatchObject({
      entrypoint: "mcp",
      caller: "mcp:client-7",
      deploymentId: publication.deploymentId,
    })
    await expect(getWorkflowRunCore({ runId: accepted.runId })).resolves.toMatchObject({
      runId: accepted.runId,
      deploymentId: publication.deploymentId,
    })

    const events = await listWorkflowEventsCore({ runId: accepted.runId, afterSequence: 0 })
    expect(events.events.every((event) => event.runId === accepted.runId)).toBe(true)

    await getDb().workflowRuns.update(accepted.runId, { status: "waiting" })
    await expect(
      cancelWorkflowRunCore({ runId: accepted.runId, caller: "mcp:client-7" })
    ).resolves.toMatchObject({ runId: accepted.runId, cancelled: true })
  })
})
