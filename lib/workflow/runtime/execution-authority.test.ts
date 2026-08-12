import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createWorkflow, updateWorkflow } from "@/lib/db/workflows"
import { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"
import {
  createPublishedWorkflowDependencyBinding,
  executeDeployedWorkflow,
  retryWorkflowRun,
} from "./execution-authority"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("ExecutionAuthority", () => {
  it("freezes a published deployment and its dependency lock into a reusable binding", async () => {
    const workflow = await createWorkflow({ name: "Verifier", nodes: [], edges: [] })
    const published = await publishWorkflow(workflow.id, 10)
    await expect(createPublishedWorkflowDependencyBinding(workflow.id)).resolves.toEqual({
      workflowId: workflow.id,
      versionId: published.versionId,
      deploymentId: published.deploymentId,
      deploymentRevision: 1,
      dependencyLock: { workflows: {}, indexes: {} },
    })
    await expect(createPublishedWorkflowDependencyBinding("missing")).rejects.toMatchObject({
      code: "deployment-not-found",
    })
  })

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

  it("keeps the immutable publication authoritative when the control plane is disabled", async () => {
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
      const row = await getDb().workflowRuns.get(execution.runId)
      expect(row?.workflowSnapshot.name).toBe("Published name")
      expect(row?.traceId).toEqual(expect.any(String))
      expect(row?.lineage).toMatchObject({ rootRunId: execution.runId })
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

  it("creates distinct original-version and current-deployment retry runs", async () => {
    const workflow = await createWorkflow({ name: "Version one", nodes: [], edges: [] })
    await publishWorkflow(workflow.id, 10)
    const seed = await executeDeployedWorkflow({
      workflowId: workflow.id,
      entrypoint: "http",
      caller: "client:seed",
      triggerKind: "trigger.manual",
      payload: { input: {} },
      traceId: "trace_seed",
    })
    await updateWorkflow(workflow.id, { name: "Version two" })
    await publishWorkflow(workflow.id, 20)

    const original = await retryWorkflowRun({
      runId: seed.runId,
      mode: "original-version",
      operatedBy: "operator:alice",
    })
    const current = await retryWorkflowRun({
      runId: seed.runId,
      mode: "current-deployment",
      operatedBy: "operator:alice",
    })

    expect(original.runId).not.toBe(seed.runId)
    expect(current.runId).not.toBe(seed.runId)
    expect((await getDb().workflowRuns.get(original.runId))?.workflowSnapshot.name).toBe(
      "Version one"
    )
    expect((await getDb().workflowRuns.get(current.runId))?.workflowSnapshot.name).toBe(
      "Version two"
    )
    expect(await getDb().workflowRuns.get(original.runId)).toMatchObject({
      traceId: "trace_seed",
      lineage: {
        rootRunId: seed.runId,
        retryOfRunId: seed.runId,
        retryMode: "original-version",
      },
    })
    expect(await getDb().workflowRuns.get(current.runId)).toMatchObject({
      traceId: "trace_seed",
      lineage: {
        rootRunId: seed.runId,
        retryOfRunId: seed.runId,
        retryMode: "current-deployment",
      },
    })
    const invocation = await getDb().workflowInvocations.get(original.invocationId)
    expect(invocation).toMatchObject({
      retryOfRunId: seed.runId,
      retryMode: "original-version",
      operatedBy: "operator:alice",
    })
  })

  it("continues from a step on the frozen version with seeded prior outputs", async () => {
    const workflow = await createWorkflow({
      name: "From step",
      nodes: [
        {
          id: "start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "Start", params: {} },
        },
        {
          id: "set",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "Set", params: { variable: "answer", value: 42 } },
        },
      ],
      edges: [{ id: "edge", source: "start", target: "set" }],
    })
    await publishWorkflow(workflow.id, 10)
    const seed = await executeDeployedWorkflow({
      workflowId: workflow.id,
      entrypoint: "http",
      caller: "client:seed",
      triggerKind: "trigger.manual",
      payload: {},
    })

    const retry = await retryWorkflowRun({
      runId: seed.runId,
      mode: "failed-step",
      startStepId: "set",
      operatedBy: "operator:bob",
    })

    expect(retry.result.status).toBe("succeeded")
    expect(await getDb().workflowInvocations.get(retry.invocationId)).toMatchObject({
      retryMode: "failed-step",
      retryOfRunId: seed.runId,
      startStepId: "set",
      seedRunId: seed.runId,
    })
  })

  it("refuses a formal retry for a legacy draft run without an immutable binding", async () => {
    const workflow = await createWorkflow({ name: "Draft", nodes: [], edges: [] })
    await getDb().workflowRuns.add({
      id: "run_draft",
      workflowId: workflow.id,
      status: "failed",
      triggerKind: "trigger.manual",
      triggerPayload: {},
      triggerOriginAt: 1,
      startedAt: 1,
      workflowSnapshot: workflow,
      triggeredBySource: "ui",
    })

    await expect(
      retryWorkflowRun({
        runId: "run_draft",
        mode: "original-version",
        operatedBy: "operator:alice",
      })
    ).rejects.toMatchObject({ code: "seed-run-not-formal" })
  })

  it("rejects unpublished roots and unpublished subworkflow dependencies", async () => {
    const unpublished = await createWorkflow({ name: "Unpublished", nodes: [], edges: [] })
    await expect(
      executeDeployedWorkflow({
        workflowId: unpublished.id,
        environment: "production",
        entrypoint: "http",
        caller: "client:missing",
        triggerKind: "trigger.manual",
        payload: {},
      })
    ).rejects.toMatchObject({ code: "deployment-not-found" })

    const parent = await createWorkflow({
      name: "Missing dependency",
      nodes: [
        {
          id: "child",
          type: "flow.subworkflow",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "Child", params: { workflowId: unpublished.id } },
        },
      ],
      edges: [],
    })
    await publishWorkflow(parent.id, 10)
    await expect(
      executeDeployedWorkflow({
        workflowId: parent.id,
        entrypoint: "http",
        caller: "client:missing-child",
        triggerKind: "trigger.manual",
        payload: {},
      })
    ).rejects.toMatchObject({ code: "dependency-not-deployed" })
  })

  it("rejects a locked artifact selected for another workflow", async () => {
    const first = await createWorkflow({ name: "First", nodes: [], edges: [] })
    const second = await createWorkflow({ name: "Second", nodes: [], edges: [] })
    const publication = await publishWorkflow(first.id, 10)

    await expect(
      executeDeployedWorkflow({
        workflowId: second.id,
        entrypoint: "subworkflow",
        caller: "workflow:parent",
        triggerKind: "trigger.manual",
        payload: {},
        lockedDependency: {
          workflowId: first.id,
          versionId: publication.versionId,
          deploymentId: publication.deploymentId,
          deploymentRevision: 1,
        },
      })
    ).rejects.toMatchObject({ code: "dependency-lock-invalid" })
  })

  it("preserves explicit trigger and retry provenance on formal admission", async () => {
    const workflow = await createWorkflow({
      name: "Rich provenance",
      nodes: [
        {
          id: "manual",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "Manual", params: {} },
        },
      ],
      edges: [],
    })
    await publishWorkflow(workflow.id, 10)
    const admitted = jest.fn()
    const persisted = jest.fn()

    const execution = await executeDeployedWorkflow({
      workflowId: workflow.id,
      entrypoint: "mcp",
      caller: "principal:admin",
      authorizedScopes: ["workflow:admin"],
      idempotencyKey: "rich-provenance",
      triggerKind: "trigger.manual",
      triggerId: "manual",
      triggerBinding: { sessionId: "session-rich" },
      triggerOriginAt: 123,
      payload: { input: {} },
      requestedRunId: "run_explicit",
      traceId: "trace_explicit",
      triggeredBy: { source: "ui" },
      securityContext: {
        piiEgressRequired: true,
        sourceTriggerKind: "trigger.connector.inbound",
      },
      retry: {
        retryOfRunId: "run_seed",
        retryMode: "original-version",
        operatedBy: "operator:admin",
      },
      onAdmitted: admitted,
      onPersisted: persisted,
    })

    expect(execution.runId).toBe("run_explicit")
    expect(admitted).toHaveBeenCalledWith("run_explicit")
    expect(persisted).toHaveBeenCalledWith("run_explicit")
    await expect(getDb().workflowRuns.get("run_explicit")).resolves.toMatchObject({
      triggerId: "manual",
      triggerBinding: { sessionId: "session-rich" },
      triggerOriginAt: 123,
      traceId: "trace_explicit",
      lineage: {
        rootRunId: "run_explicit",
        retryOfRunId: "run_seed",
        retryMode: "original-version",
      },
      securityContext: { piiEgressRequired: true },
    })
  })

  it("rejects disabled and mismatched trigger bindings from the immutable artifact", async () => {
    const workflow = await createWorkflow({
      name: "Trigger binding",
      nodes: [
        {
          id: "disabled",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "Disabled", params: {}, disabled: true },
        },
        {
          id: "enabled",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 100 },
          data: { label: "Enabled", params: {} },
        },
      ],
      edges: [],
    })
    await publishWorkflow(workflow.id, 10)
    const base = {
      workflowId: workflow.id,
      entrypoint: "trigger" as const,
      caller: "scheduler",
      payload: {},
    }

    await expect(
      executeDeployedWorkflow({
        ...base,
        triggerKind: "trigger.manual",
        triggerId: "disabled",
      })
    ).rejects.toMatchObject({ code: "trigger-binding-invalid" })
    await expect(
      executeDeployedWorkflow({
        ...base,
        triggerKind: "trigger.cron",
        triggerId: "enabled",
      })
    ).rejects.toMatchObject({ code: "trigger-binding-invalid" })
  })

  it("fails legacy formal execution without a publication or immutable artifact", async () => {
    const previous = process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
    process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS = "false"
    try {
      const unpublished = await createWorkflow({ name: "Legacy draft", nodes: [], edges: [] })
      const request = {
        workflowId: unpublished.id,
        entrypoint: "http" as const,
        caller: "legacy-client",
        triggerKind: "trigger.manual" as const,
        payload: {},
      }
      await expect(executeDeployedWorkflow(request)).rejects.toMatchObject({
        code: "deployment-not-found",
      })

      const publication = await publishWorkflow(unpublished.id, 10)
      await getDb().workflowVersions.delete(publication.versionId)
      await expect(executeDeployedWorkflow(request)).rejects.toMatchObject({
        code: "publication-version-missing",
      })

      const stored = (await getDb().workflows.get(unpublished.id))!
      await getDb().workflows.put({
        ...stored,
        published: { ...stored.published!, versionId: undefined },
      })
      await expect(executeDeployedWorkflow(request)).rejects.toMatchObject({
        code: "publication-version-missing",
      })
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
      else process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS = previous
    }
  })

  it("keeps legacy retries bound to their frozen artifact and prior step outputs", async () => {
    const previous = process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
    process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS = "false"
    try {
      const workflow = await createWorkflow({
        name: "Legacy retry",
        nodes: [
          {
            id: "manual",
            type: "trigger.manual",
            typeVersion: 1,
            position: { x: 0, y: 0 },
            data: { label: "Manual", params: {} },
          },
          {
            id: "set",
            type: "flow.set",
            typeVersion: 1,
            position: { x: 200, y: 0 },
            data: { label: "Set", params: { variable: "answer", value: 42 } },
          },
        ],
        edges: [{ id: "edge", source: "manual", target: "set" }],
      })
      await publishWorkflow(workflow.id, 10)
      const stored = (await getDb().workflows.get(workflow.id))!
      await getDb().workflows.put({
        ...stored,
        published: {
          ...stored.published!,
          deploymentId: undefined,
          deploymentRevision: undefined,
        },
      })
      const seed = await executeDeployedWorkflow({
        workflowId: workflow.id,
        entrypoint: "trigger",
        caller: "legacy-trigger",
        triggerKind: "trigger.manual",
        payload: {},
      })
      const admitted = jest.fn()
      const persisted = jest.fn()

      const retried = await executeDeployedWorkflow({
        workflowId: workflow.id,
        entrypoint: "desktop",
        caller: "legacy-operator",
        idempotencyKey: "legacy-retry",
        triggerKind: "trigger.manual",
        triggerId: "manual",
        triggerBinding: { sessionId: "legacy-session" },
        triggerOriginAt: 456,
        payload: {},
        requestedRunId: "run_legacy_retry",
        traceId: "trace_legacy_retry",
        retry: {
          retryOfRunId: seed.runId,
          retryMode: "failed-step",
          operatedBy: "legacy-operator",
          startStepId: "set",
          seedRunId: seed.runId,
        },
        onAdmitted: admitted,
        onPersisted: persisted,
      })

      expect(retried.result.status).toBe("succeeded")
      expect(retried.executionBinding).toMatchObject({
        deploymentId: `legacy:${workflow.id}`,
        deploymentRevision: 0,
        idempotencyKey: "legacy-retry",
      })
      expect(admitted).toHaveBeenCalledWith("run_legacy_retry")
      expect(persisted).toHaveBeenCalledWith("run_legacy_retry")
      await expect(getDb().workflowRuns.get("run_legacy_retry")).resolves.toMatchObject({
        triggerId: "manual",
        triggerBinding: { sessionId: "legacy-session" },
        traceId: "trace_legacy_retry",
        lineage: {
          rootRunId: "run_legacy_retry",
          retryOfRunId: seed.runId,
          retryMode: "failed-step",
        },
      })
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
      else process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS = previous
    }
  })

  it("detects corrupt reused invocations and missing immutable versions", async () => {
    const workflow = await createWorkflow({ name: "Corrupt reuse", nodes: [], edges: [] })
    await publishWorkflow(workflow.id, 10)
    const request = {
      workflowId: workflow.id,
      entrypoint: "http" as const,
      caller: "client:corrupt",
      idempotencyKey: "corrupt-run-id",
      triggerKind: "trigger.manual" as const,
      payload: {},
    }
    const first = await executeDeployedWorkflow(request)
    const invocation = (await getDb().workflowInvocations.get(first.invocationId))!
    await getDb().workflowInvocations.put({ ...invocation, runId: undefined })
    await expect(executeDeployedWorkflow(request)).rejects.toMatchObject({
      code: "invocation-corrupt",
    })

    const versionRequest = { ...request, idempotencyKey: "missing-version" }
    const second = await executeDeployedWorkflow(versionRequest)
    await getDb().workflowInvocations.update(second.invocationId, {
      versionId: "version_missing",
    })
    await expect(executeDeployedWorkflow(versionRequest)).rejects.toMatchObject({
      code: "invocation-version-missing",
    })
  })

  it("returns a durable pending view when a completed run row was removed", async () => {
    const workflow = await createWorkflow({ name: "Missing run", nodes: [], edges: [] })
    await publishWorkflow(workflow.id, 10)
    const request = {
      workflowId: workflow.id,
      entrypoint: "http" as const,
      caller: "client:missing-run",
      idempotencyKey: "missing-run",
      triggerKind: "trigger.manual" as const,
      payload: {},
    }
    const first = await executeDeployedWorkflow(request)
    await getDb().workflowRuns.delete(first.runId)

    await expect(executeDeployedWorkflow(request)).resolves.toMatchObject({
      reused: true,
      runId: first.runId,
      result: { status: "pending" },
    })
  })

  it("rejects missing seed runs and failed-step retries without a failure node", async () => {
    await expect(
      retryWorkflowRun({
        runId: "run_missing",
        mode: "original-version",
        operatedBy: "operator:test",
      })
    ).rejects.toMatchObject({ code: "seed-run-not-found" })

    const workflow = await createWorkflow({ name: "Successful seed", nodes: [], edges: [] })
    await publishWorkflow(workflow.id, 10)
    const seed = await executeDeployedWorkflow({
      workflowId: workflow.id,
      entrypoint: "http",
      caller: "client:seed",
      triggerKind: "trigger.manual",
      payload: {},
    })
    await expect(
      retryWorkflowRun({
        runId: seed.runId,
        mode: "failed-step",
        operatedBy: "operator:test",
      })
    ).rejects.toMatchObject({ code: "failed-step-missing" })
  })
})
