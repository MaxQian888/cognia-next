import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createWorkflow } from "@/lib/db/workflows"
import { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"
import {
  createWorkflowApiRun,
  getWorkflowApiRun,
  listWorkflowApiEvents,
  cancelWorkflowApiRun,
  dispatchWorkflowApiBridgeCommand,
  WorkflowApiServiceError,
} from "./workflow-api-service"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

async function publishedWorkflow(name = "HTTP workflow") {
  const workflow = await createWorkflow({ name, nodes: [], edges: [] })
  const publication = await publishWorkflow(workflow.id, 10)
  return { workflow, publication }
}

describe("workflow HTTP API service", () => {
  it("admits a deployment-scoped run and reuses the original run for an idempotency key", async () => {
    const { publication } = await publishedWorkflow()
    const accountId = (await getDb().workflowDeployments.get(publication.deploymentId))!.accountId
    const request = {
      accountId,
      deploymentId: publication.deploymentId,
      caller: "oidc:user-1",
      scopes: ["workflow:run"],
      idempotencyKey: "request-42",
      input: { topic: "shipping" },
    }

    const first = await createWorkflowApiRun(request)
    const duplicate = await createWorkflowApiRun(request)

    expect(duplicate.runId).toBe(first.runId)
    expect(await getDb().workflowInvocations.count()).toBe(1)
    expect(await getDb().workflowRuns.count()).toBe(1)
    expect((await getDb().workflowRuns.get(first.runId))?.executionBinding).toMatchObject({
      entrypoint: "http",
      caller: "oidc:user-1",
      deploymentId: publication.deploymentId,
    })
  })

  it("fails closed for another account and for a caller without workflow:run", async () => {
    const { publication } = await publishedWorkflow()
    const accountId = (await getDb().workflowDeployments.get(publication.deploymentId))!.accountId

    await expect(
      createWorkflowApiRun({
        accountId: "acct_other",
        deploymentId: publication.deploymentId,
        caller: "oidc:user-1",
        scopes: ["workflow:run"],
        input: {},
      })
    ).rejects.toMatchObject({ code: "deployment_not_found", status: 404 })

    await expect(
      createWorkflowApiRun({
        accountId,
        deploymentId: publication.deploymentId,
        caller: "oidc:user-1",
        scopes: ["workflow:read"],
        input: {},
      })
    ).rejects.toMatchObject({ code: "scope_denied", status: 403 })
  })

  it("returns an account-scoped status projection without the workflow snapshot", async () => {
    const { publication } = await publishedWorkflow()
    const deployment = (await getDb().workflowDeployments.get(publication.deploymentId))!
    const started = await createWorkflowApiRun({
      accountId: deployment.accountId,
      deploymentId: deployment.id,
      caller: "oidc:user-1",
      scopes: ["workflow:run"],
      input: {},
    })

    const status = await getWorkflowApiRun({
      accountId: deployment.accountId,
      runId: started.runId,
      scopes: ["workflow:read"],
    })

    expect(status).toMatchObject({
      runId: started.runId,
      workflowId: deployment.workflowId,
      versionId: publication.versionId,
      deploymentId: deployment.id,
    })
    expect(status).not.toHaveProperty("workflowSnapshot")

    await getDb().workflowRuns.update(started.runId, {
      status: "failed",
      error: { message: "failed for alice@example.com", stack: "private stack" },
    })
    const failed = await getWorkflowApiRun({
      accountId: deployment.accountId,
      runId: started.runId,
      scopes: ["workflow:read"],
    })
    expect(failed.error?.message).not.toContain("alice@example.com")
    expect(failed.error).not.toHaveProperty("stack")

    let deeplyNested: Record<string, unknown> = { apiKey: "sk-deep-secret" }
    for (let depth = 0; depth < 25; depth += 1) deeplyNested = { child: deeplyNested }
    await getDb().workflowRuns.update(started.runId, { output: deeplyNested })
    const redacted = await getWorkflowApiRun({
      accountId: deployment.accountId,
      runId: started.runId,
      scopes: ["workflow:read"],
    })
    expect(JSON.stringify(redacted.output)).not.toContain("sk-deep-secret")

    await expect(
      getWorkflowApiRun({
        accountId: "acct_other",
        runId: started.runId,
        scopes: ["workflow:read"],
      })
    ).rejects.toBeInstanceOf(WorkflowApiServiceError)
  })

  it("uses durable event sequences as monotonic cursors and redacts sensitive payload fields", async () => {
    const { publication } = await publishedWorkflow()
    const deployment = (await getDb().workflowDeployments.get(publication.deploymentId))!
    const started = await createWorkflowApiRun({
      accountId: deployment.accountId,
      deploymentId: deployment.id,
      caller: "oidc:user-1",
      scopes: ["workflow:run"],
      input: {},
    })
    await getDb().workflowRunEvents.where("runId").equals(started.runId).delete()
    await getDb().workflowRunEvents.bulkPut([
      {
        id: "evt_api_1",
        runId: started.runId,
        sequence: 1,
        ts: 100,
        type: "run_log",
        payload: { message: "contact alice@example.com", apiKey: "sk-secret" },
      },
      {
        id: "evt_api_2",
        runId: started.runId,
        sequence: 2,
        ts: 101,
        type: "step_completed",
        stepId: "node-1",
        payload: { output: { ok: true } },
      },
    ])

    const page = await listWorkflowApiEvents({
      accountId: deployment.accountId,
      runId: started.runId,
      scopes: ["workflow:read"],
      afterSequence: 1,
    })

    expect(page.events).toEqual([
      expect.objectContaining({
        runId: started.runId,
        sequence: 2,
        type: "step_completed",
        stepId: "node-1",
      }),
    ])

    const firstPage = await listWorkflowApiEvents({
      accountId: deployment.accountId,
      runId: started.runId,
      scopes: ["workflow:read"],
      afterSequence: 0,
    })
    expect(firstPage.events[0]?.payload).toEqual({
      message: expect.not.stringContaining("alice@example.com"),
      apiKey: "[REDACTED]",
    })

    const boundedPage = await listWorkflowApiEvents({
      accountId: deployment.accountId,
      runId: started.runId,
      scopes: ["workflow:read"],
      afterSequence: 0,
      limit: 1,
    })
    expect(boundedPage.terminal).toBe(false)
  })

  it("cancels only an account-owned non-terminal run", async () => {
    const { publication } = await publishedWorkflow()
    const deployment = (await getDb().workflowDeployments.get(publication.deploymentId))!
    const started = await createWorkflowApiRun({
      accountId: deployment.accountId,
      deploymentId: deployment.id,
      caller: "oidc:user-1",
      scopes: ["workflow:run"],
      input: {},
    })
    await getDb().workflowRuns.update(started.runId, { status: "waiting" })

    const cancelled = await cancelWorkflowApiRun({
      accountId: deployment.accountId,
      runId: started.runId,
      scopes: ["workflow:run"],
      caller: "oidc:user-1",
    })
    expect(cancelled).toMatchObject({ runId: started.runId, cancelled: true })

    await expect(
      cancelWorkflowApiRun({
        accountId: "acct_other",
        runId: started.runId,
        scopes: ["workflow:run"],
        caller: "oidc:user-2",
      })
    ).rejects.toMatchObject({ code: "run_not_found", status: 404 })
  })

  it("returns stable bridge errors for invalid cursors and denied scopes", async () => {
    await expect(
      dispatchWorkflowApiBridgeCommand("workflow_api_events_list", {
        accountId: "local_acct_a",
        runId: "run-1",
        scopes: ["workflow:read"],
        afterSequence: "yesterday",
      })
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid_event_cursor",
        status: 400,
        message: "Last-Event-ID must be a non-negative safe integer",
      },
    })

    await expect(
      dispatchWorkflowApiBridgeCommand("workflow_api_run_create", {
        accountId: "local_acct_a",
        deploymentId: "deployment-1",
        caller: "oidc:user-1",
        scopes: ["workflow:read"],
        input: {},
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "scope_denied", status: 403 },
    })
  })
})
