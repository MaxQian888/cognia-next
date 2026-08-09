import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createWorkflow, updateWorkflow } from "@/lib/db/workflows"
import { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"
import { executeDeployedWorkflow } from "./execution-authority"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("ExecutionAuthority", () => {
  it("runs the deployed version and stamps immutable provenance on the run", async () => {
    const workflow = await createWorkflow({ name: "Authority", nodes: [], edges: [] })
    const published = await publishWorkflow(workflow.id, 10)
    await updateWorkflow(workflow.id, { name: "Edited draft" })

    const execution = await executeDeployedWorkflow({
      workflowId: workflow.id,
      entrypoint: "mcp",
      caller: "principal:alice",
      triggerKind: "trigger.manual",
      payload: { input: {} },
    })

    expect(execution.result.status).toBe("succeeded")
    const row = await getDb().workflowRuns.get(execution.runId)
    expect(row?.workflowSnapshot.name).toBe("Authority")
    expect(row).toMatchObject({
      versionId: published.versionId,
      deploymentId: published.deploymentId,
      deploymentRevision: 1,
      executionBinding: {
        entrypoint: "mcp",
        caller: "principal:alice",
        versionId: published.versionId,
      },
    })
  })

  it("locks declared subworkflow deployments before the root run starts", async () => {
    const child = await createWorkflow({ name: "Child", nodes: [], edges: [] })
    const childPublication = await publishWorkflow(child.id, 5)
    const parent = await createWorkflow({
      name: "Parent",
      nodes: [
        {
          id: "child-step",
          type: "flow.subworkflow",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "child", params: { workflowId: child.id } },
        },
      ],
      edges: [],
    })
    await publishWorkflow(parent.id, 10)

    const execution = await executeDeployedWorkflow({
      workflowId: parent.id,
      entrypoint: "http",
      caller: "client:lock",
      triggerKind: "trigger.manual",
      payload: {},
    })

    const row = await getDb().workflowRuns.get(execution.runId)
    expect(
      (
        row as typeof row & {
          dependencyLock?: { workflows: Record<string, { versionId: string }> }
        }
      )?.dependencyLock?.workflows["child-step"]
    ).toMatchObject({ workflowId: child.id, versionId: childPublication.versionId })
  })

  it("rejects dependency cycles before creating run state", async () => {
    const workflow = await createWorkflow({ name: "Recursive", nodes: [], edges: [] })
    await updateWorkflow(workflow.id, {
      nodes: [
        {
          id: "self",
          type: "flow.subworkflow",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "self", params: { workflowId: workflow.id } },
        },
      ],
    })
    await publishWorkflow(workflow.id, 10)

    await expect(
      executeDeployedWorkflow({
        workflowId: workflow.id,
        entrypoint: "http",
        caller: "client:cycle",
        triggerKind: "trigger.manual",
        payload: {},
      })
    ).rejects.toMatchObject({ code: "dependency-cycle" })
    expect(await getDb().workflowInvocations.count()).toBe(0)
    expect(await getDb().workflowRuns.count()).toBe(0)
  })

  it("returns the original run for a duplicate idempotency key", async () => {
    const workflow = await createWorkflow({ name: "Idempotent", nodes: [], edges: [] })
    await publishWorkflow(workflow.id, 10)
    const request = {
      workflowId: workflow.id,
      entrypoint: "http" as const,
      caller: "client:one",
      idempotencyKey: "request-42",
      triggerKind: "trigger.manual" as const,
      payload: { input: {} },
    }

    const [first, duplicate] = await Promise.all([
      executeDeployedWorkflow(request),
      executeDeployedWorkflow(request),
    ])

    expect(duplicate.runId).toBe(first.runId)
    expect(duplicate.reused).toBe(true)
    expect(await getDb().workflowInvocations.count()).toBe(1)
    expect(await getDb().workflowRuns.count()).toBe(1)
  })

  it("falls back to the legacy live publication when the control plane is disabled", async () => {
    const previous = process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
    process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS = "false"
    try {
      const workflow = await createWorkflow({ name: "Published name", nodes: [], edges: [] })
      await publishWorkflow(workflow.id, 10)
      await updateWorkflow(workflow.id, { name: "Edited legacy draft" })

      const execution = await executeDeployedWorkflow({
        workflowId: workflow.id,
        entrypoint: "trigger",
        caller: "trigger.manual",
        triggerKind: "trigger.manual",
        payload: {},
      })

      expect(execution.result.status).toBe("succeeded")
      expect((await getDb().workflowRuns.get(execution.runId))?.workflowSnapshot.name).toBe(
        "Edited legacy draft"
      )
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
      else process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS = previous
    }
  })

  it("keeps legacy rollback trigger validation", async () => {
    const previous = process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
    process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS = "0"
    try {
      const workflow = await createWorkflow({
        name: "Legacy trigger validation",
        nodes: [
          {
            id: "manual",
            type: "trigger.manual",
            typeVersion: 1,
            position: { x: 0, y: 0 },
            data: { label: "manual", params: {} },
          },
        ],
        edges: [],
      })
      await publishWorkflow(workflow.id, 10)

      await expect(
        executeDeployedWorkflow({
          workflowId: workflow.id,
          entrypoint: "trigger",
          caller: "trigger.manual",
          triggerKind: "trigger.manual",
          triggerId: "deleted-trigger",
          payload: {},
        })
      ).rejects.toMatchObject({ code: "trigger-binding-invalid" })
      expect(await getDb().workflowRuns.count()).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
      else process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS = previous
    }
  })

  it("recovers an orphaned pending admission on an idempotent retry", async () => {
    const workflow = await createWorkflow({ name: "Recover admission", nodes: [], edges: [] })
    await publishWorkflow(workflow.id, 10)
    const request = {
      workflowId: workflow.id,
      entrypoint: "http" as const,
      caller: "client:recovery",
      idempotencyKey: "request-recovery",
      triggerKind: "trigger.manual" as const,
      payload: { input: {} },
    }
    const first = await executeDeployedWorkflow(request)
    const invocation = (await getDb().workflowInvocations.toArray())[0]!
    await getDb().transaction("rw", getDb().workflowInvocations, getDb().workflowRuns, async () => {
      await getDb().workflowInvocations.update(invocation.id, { status: "running" })
      await getDb().workflowRuns.update(first.runId, {
        status: "pending",
        completedAt: undefined,
        lease: undefined,
      })
    })

    const recovered = await executeDeployedWorkflow(request)

    expect(recovered).toMatchObject({ reused: true, runId: first.runId })
    expect(recovered.result.status).toBe("succeeded")
    expect((await getDb().workflowInvocations.get(invocation.id))?.status).toBe("completed")
    expect((await getDb().workflowRuns.get(first.runId))?.status).toBe("succeeded")
  })

  it("keeps an idempotent retry bound to its original version after redeployment", async () => {
    const workflow = await createWorkflow({ name: "Stable retry", nodes: [], edges: [] })
    const firstPublication = await publishWorkflow(workflow.id, 10)
    const request = {
      workflowId: workflow.id,
      entrypoint: "http" as const,
      caller: "client:one",
      idempotencyKey: "request-before-upgrade",
      triggerKind: "trigger.manual" as const,
      payload: { input: {} },
    }
    const first = await executeDeployedWorkflow(request)

    await updateWorkflow(workflow.id, {
      nodes: [
        {
          id: "start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: {
            label: "Start",
            params: {
              inputSchema: {
                type: "object",
                properties: { topic: { type: "string" } },
                required: ["topic"],
              },
            },
          },
        },
      ],
    })
    await publishWorkflow(workflow.id, 20)

    const retry = await executeDeployedWorkflow(request)
    expect(retry).toMatchObject({
      reused: true,
      runId: first.runId,
      version: { id: firstPublication.versionId },
      executionBinding: {
        versionId: firstPublication.versionId,
        deploymentRevision: 1,
      },
    })
    await expect(
      executeDeployedWorkflow({ ...request, idempotencyKey: "new-request" })
    ).rejects.toMatchObject({ code: "input-schema-violation" })
  })

  it("rejects callers without workflow:run before creating a ledger row", async () => {
    const workflow = await createWorkflow({ name: "Private", nodes: [], edges: [] })
    await publishWorkflow(workflow.id, 10)

    await expect(
      executeDeployedWorkflow({
        workflowId: workflow.id,
        entrypoint: "http",
        caller: "client:read-only",
        authorizedScopes: ["workflow:read"],
        triggerKind: "trigger.manual",
        payload: {},
      })
    ).rejects.toThrow(/workflow:run/)
    expect(await getDb().workflowInvocations.count()).toBe(0)
  })
})
