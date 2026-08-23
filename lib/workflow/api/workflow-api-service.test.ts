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
  probeWorkflowPlacement,
  WorkflowApiServiceError,
} from "./workflow-api-service"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterEach(() => new Promise((resolve) => setTimeout(resolve, 10)))
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

  it("preserves a trusted non-HTTP entrypoint in the canonical execution binding", async () => {
    const { publication } = await publishedWorkflow("MCP workflow")
    const deployment = (await getDb().workflowDeployments.get(publication.deploymentId))!

    const started = await createWorkflowApiRun({
      accountId: deployment.accountId,
      deploymentId: deployment.id,
      entrypoint: "mcp",
      caller: "mcp:client-1",
      scopes: ["workflow:run", "workflow:read"],
      input: { topic: "shipping" },
    })

    expect((await getDb().workflowRuns.get(started.runId))?.executionBinding).toMatchObject({
      entrypoint: "mcp",
      caller: "mcp:client-1",
      deploymentId: deployment.id,
    })
  })

  it("locks a successful Host handoff to the selected immutable deployment", async () => {
    const { publication } = await publishedWorkflow("Exact handoff")
    const deployment = (await getDb().workflowDeployments.get(publication.deploymentId))!
    const version = (await getDb().workflowVersions.get(publication.versionId))!

    const started = await createWorkflowApiRun({
      accountId: deployment.accountId,
      deploymentId: deployment.id,
      expectedVersionDigest: version.digest,
      entrypoint: "trigger",
      caller: "host:cloud-a",
      scopes: ["workflow:admin"],
      idempotencyKey: "handoff-1",
      trigger: {
        workflowId: deployment.workflowId,
        kind: "trigger.manual",
        originAt: 100,
        payload: { value: 1 },
      },
      triggeredBy: { source: "api" },
      input: {},
    })

    expect((await getDb().workflowRuns.get(started.runId))?.executionBinding).toMatchObject({
      deploymentId: deployment.id,
      versionId: version.id,
      entrypoint: "trigger",
    })
  })

  it("probes exact deployment compatibility and rejects a mismatched handoff digest", async () => {
    const { publication } = await publishedWorkflow("Placed workflow")
    const deployment = (await getDb().workflowDeployments.get(publication.deploymentId))!
    const version = (await getDb().workflowVersions.get(publication.versionId))!

    await expect(
      probeWorkflowPlacement({
        accountId: deployment.accountId,
        deploymentId: deployment.id,
        expectedVersionDigest: version.digest,
        scopes: ["workflow:read"],
      })
    ).resolves.toMatchObject({
      compatible: true,
      workflowId: deployment.workflowId,
      deploymentDigest: version.digest,
      activeUnits: 0,
      maxUnits: 1,
    })

    await expect(
      createWorkflowApiRun({
        accountId: deployment.accountId,
        deploymentId: deployment.id,
        expectedVersionDigest: "wfv1:different",
        caller: "host:source",
        scopes: ["workflow:run"],
        input: {},
      })
    ).rejects.toMatchObject({ code: "deployment_digest_mismatch", status: 409 })
  })

  it("reports placement incompatibility without leaking deployments across accounts", async () => {
    const { publication } = await publishedWorkflow("Placement compatibility")
    const deployment = (await getDb().workflowDeployments.get(publication.deploymentId))!
    const version = (await getDb().workflowVersions.get(publication.versionId))!

    await expect(
      probeWorkflowPlacement({
        accountId: "acct_other",
        deploymentId: deployment.id,
        expectedVersionDigest: version.digest,
        scopes: ["workflow:read"],
      })
    ).resolves.toEqual({
      compatible: false,
      reason: "deployment_not_found",
      activeUnits: 0,
      maxUnits: 0,
    })

    await getDb().workflowDeployments.update(deployment.id, { status: "disabled" })
    await expect(
      probeWorkflowPlacement({
        accountId: deployment.accountId,
        deploymentId: deployment.id,
        expectedVersionDigest: version.digest,
        scopes: ["workflow:read"],
      })
    ).resolves.toMatchObject({ compatible: false, reason: "deployment_not_found" })

    await getDb().workflowDeployments.update(deployment.id, {
      status: "active",
      versionId: "missing-version",
    })
    await expect(
      probeWorkflowPlacement({
        accountId: deployment.accountId,
        deploymentId: deployment.id,
        expectedVersionDigest: version.digest,
        scopes: ["workflow:read"],
      })
    ).resolves.toMatchObject({ compatible: false, reason: "deployment_not_found" })

    await getDb().workflowDeployments.update(deployment.id, {
      status: "active",
      versionId: version.id,
    })
    await expect(
      probeWorkflowPlacement({
        accountId: deployment.accountId,
        deploymentId: deployment.id,
        expectedVersionDigest: "wfv1:different",
        scopes: ["workflow:read"],
      })
    ).resolves.toMatchObject({
      compatible: false,
      reason: "deployment_digest_mismatch",
      deploymentDigest: version.digest,
    })
  })

  it("rejects inactive deployments and deployments with a missing immutable version", async () => {
    const { publication } = await publishedWorkflow("Inactive deployment")
    const deployment = (await getDb().workflowDeployments.get(publication.deploymentId))!
    const request = {
      accountId: deployment.accountId,
      deploymentId: deployment.id,
      caller: "oidc:user-1",
      scopes: ["workflow:run"],
      input: {},
    }

    await getDb().workflowDeployments.update(deployment.id, { status: "disabled" })
    await expect(createWorkflowApiRun(request)).rejects.toMatchObject({
      code: "deployment_not_found",
      status: 404,
    })

    await getDb().workflowDeployments.update(deployment.id, {
      status: "active",
      versionId: "missing-version",
    })
    await expect(createWorkflowApiRun(request)).rejects.toMatchObject({
      code: "deployment_not_found",
      status: 404,
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

  it("fails closed for runs without an owned deployment and projects every optional field", async () => {
    const { publication } = await publishedWorkflow("Run projection")
    const deployment = (await getDb().workflowDeployments.get(publication.deploymentId))!
    const started = await createWorkflowApiRun({
      accountId: deployment.accountId,
      deploymentId: deployment.id,
      caller: "oidc:user-1",
      scopes: ["workflow:run"],
      input: {},
    })
    const run = (await getDb().workflowRuns.get(started.runId))!

    await getDb().workflowRuns.update(run.id, {
      completedAt: 500,
      output: [null, 7, "alice@example.com"],
      error: { message: "failed", nodeId: "node-1", code: "node_failed" },
    })
    await expect(
      getWorkflowApiRun({
        accountId: deployment.accountId,
        runId: run.id,
        scopes: ["workflow:read"],
      })
    ).resolves.toMatchObject({
      completedAt: 500,
      output: [null, 7, expect.not.stringContaining("alice@example.com")],
      error: { nodeId: "node-1", code: "node_failed" },
    })

    await getDb().workflowRuns.update(run.id, { deploymentId: undefined })
    await expect(
      getWorkflowApiRun({
        accountId: deployment.accountId,
        runId: run.id,
        scopes: ["workflow:read"],
      })
    ).rejects.toMatchObject({ code: "run_not_found" })

    await getDb().workflowRuns.update(run.id, { deploymentId: deployment.id })
    await getDb().workflowDeployments.delete(deployment.id)
    await expect(
      getWorkflowApiRun({
        accountId: deployment.accountId,
        runId: run.id,
        scopes: ["workflow:read"],
      })
    ).rejects.toMatchObject({ code: "run_not_found" })
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
        level: "info",
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
        level: "info",
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

  it("serves get, events, and cancel through the stable bridge", async () => {
    const { publication } = await publishedWorkflow("Bridge workflow")
    const deployment = (await getDb().workflowDeployments.get(publication.deploymentId))!
    await expect(
      dispatchWorkflowApiBridgeCommand("workflow_api_run_create", {
        accountId: deployment.accountId,
        deploymentId: deployment.id,
        caller: "oidc:user-1",
        scopes: ["workflow:run"],
        idempotencyKey: "bridge-create-1",
        input: { via: "bridge" },
      })
    ).resolves.toMatchObject({ ok: true, data: { runId: expect.any(String) } })
    const started = await createWorkflowApiRun({
      accountId: deployment.accountId,
      deploymentId: deployment.id,
      caller: "oidc:user-1",
      scopes: ["workflow:run"],
      input: {},
    })
    await getDb().workflowRuns.update(started.runId, { status: "waiting" })

    await expect(
      dispatchWorkflowApiBridgeCommand("workflow_api_run_get", {
        accountId: deployment.accountId,
        runId: started.runId,
        scopes: ["workflow:read"],
      })
    ).resolves.toMatchObject({ ok: true, data: { runId: started.runId } })

    await expect(
      dispatchWorkflowApiBridgeCommand("workflow_api_events_list", {
        accountId: deployment.accountId,
        runId: started.runId,
        scopes: ["workflow:read"],
      })
    ).resolves.toMatchObject({ ok: true, data: { events: expect.any(Array) } })

    await expect(
      dispatchWorkflowApiBridgeCommand("workflow_api_run_cancel", {
        accountId: deployment.accountId,
        runId: started.runId,
        caller: "oidc:user-1",
        scopes: ["workflow:run"],
      })
    ).resolves.toMatchObject({ ok: true, data: { runId: started.runId } })
  })

  it("validates required bridge strings and scope arrays", async () => {
    await expect(
      dispatchWorkflowApiBridgeCommand("workflow_api_run_get", {
        accountId: "",
        runId: "run-1",
        scopes: ["workflow:read"],
      })
    ).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } })

    await expect(
      dispatchWorkflowApiBridgeCommand("workflow_api_run_get", {
        accountId: "local_acct_a",
        runId: "run-1",
        scopes: ["workflow:read", 7],
      })
    ).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } })
  })
})
