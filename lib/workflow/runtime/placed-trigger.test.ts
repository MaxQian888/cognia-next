jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: jest.fn(() => "account-default"),
}))
jest.mock("@/lib/db/host-dispatch-queue", () => ({
  enqueueHostDispatch: jest.fn(),
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/db/workflow-deployments", () => ({
  resolveWorkflowDeployment: jest.fn(),
}))
jest.mock("@/lib/remote-host/target-transport", () => ({
  openRemoteHostTarget: jest.fn(),
}))
jest.mock("./execution-authority", () => ({ executeDeployedWorkflow: jest.fn() }))

import { enqueueHostDispatch } from "@/lib/db/host-dispatch-queue"
import { getDb } from "@/lib/db/schema"
import { resolveWorkflowDeployment } from "@/lib/db/workflow-deployments"
import type { ResolvedWorkflowDeployment } from "@/lib/db/workflow-deployments"
import { openRemoteHostTarget } from "@/lib/remote-host/target-transport"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import type { HostDispatchJobRow } from "@/types/placement/host-dispatch"
import type { TriggerEvent } from "@/types/workflow/visual"
import { executeDeployedWorkflow } from "./execution-authority"
import { dispatchPlacedWorkflowTrigger, type PlacedTriggerDeps } from "./placed-trigger"

const event: TriggerEvent = {
  workflowId: "workflow-1",
  kind: "trigger.cron",
  originAt: 123,
  payload: { scheduledAt: 123 },
}

function resolved(runOn: { mode: "colocate" | "auto" } | { mode: "pinned"; ref: string }) {
  return {
    deployment: { id: "deployment-1", accountId: "account-1" },
    version: {
      digest: "wfv1:abc",
      definition: { settings: { concurrency: 4, runOn } },
    },
    workflow: { settings: { concurrency: 4, runOn } },
  } as unknown as ResolvedWorkflowDeployment
}

function queueRow(targetRef: string): HostDispatchJobRow {
  return {
    id: "dispatch-1",
    accountId: "account-1",
    domain: "schedule-handoff",
    targetRef,
    kind: "workflow.trigger",
    payload: {},
    status: "pending",
    attempts: 0,
    maxAttempts: 6,
    createdAt: 1,
    updatedAt: 1,
    nextAttemptAt: 1,
    expiresAt: 10,
    idempotencyKey: "trigger-key",
  }
}

function deps(
  deployment: ResolvedWorkflowDeployment,
  overrides: Partial<PlacedTriggerDeps> = {}
): PlacedTriggerDeps {
  return {
    resolveDeployment: jest.fn().mockResolvedValue(deployment),
    executeLocal: jest.fn().mockResolvedValue({ runId: "run-local" }),
    getLocalActiveUnits: jest.fn().mockResolvedValue(2),
    listRemoteHosts: jest.fn().mockReturnValue([]),
    probeRemote: jest.fn(),
    enqueueHandoff: jest.fn(),
    accountId: () => "account-1",
    localHostRef: () => "local",
    now: () => 500,
    ...overrides,
  }
}

describe("dispatchPlacedWorkflowTrigger", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.COGNIA_HOST_ID
    useRemoteHostStore.setState({ activeHostId: null, hosts: [] })
  })

  it("runs a draft or missing deployment locally with the full trigger context", async () => {
    const executeLocal = jest.fn().mockResolvedValue({ runId: "run-draft" })
    const d = deps(resolved({ mode: "colocate" }), {
      resolveDeployment: jest.fn().mockResolvedValue(undefined),
      executeLocal,
    })

    await expect(
      dispatchPlacedWorkflowTrigger(
        {
          event: { ...event, triggerId: "trigger-1", binding: { value: 1 } },
          idempotencyKey: "draft-key",
          triggeredBy: { source: "desktop" },
        },
        d
      )
    ).resolves.toEqual({ kind: "local", runId: "run-draft" })
    expect(executeLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: "trigger.cron",
        triggerId: "trigger-1",
        triggerBinding: { value: 1 },
        triggerOriginAt: 123,
        idempotencyKey: "draft-key",
        triggeredBy: { source: "desktop" },
      })
    )
  })

  it("keeps the zero-configuration colocate path local", async () => {
    const d = deps(resolved({ mode: "colocate" }))

    await expect(
      dispatchPlacedWorkflowTrigger({ event, idempotencyKey: "trigger-key" }, d)
    ).resolves.toEqual({ kind: "local", runId: "run-local" })

    expect(d.executeLocal).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "workflow-1", triggerKind: "trigger.cron" })
    )
    expect(d.listRemoteHosts).not.toHaveBeenCalled()
    expect(d.enqueueHandoff).not.toHaveBeenCalled()
  })

  it("defaults an older published definition without runOn to colocated execution", async () => {
    const deployment = resolved({ mode: "auto" })
    delete deployment.version.definition.settings.runOn
    const d = deps(deployment)

    await expect(dispatchPlacedWorkflowTrigger({ event }, d)).resolves.toEqual({
      kind: "local",
      runId: "run-local",
    })
    expect(d.listRemoteHosts).not.toHaveBeenCalled()
  })

  it("pins an exact published digest into one durable remote handoff", async () => {
    const onAdmitted = jest.fn()
    const d = deps(resolved({ mode: "pinned", ref: "cloud-a" }), {
      listRemoteHosts: jest.fn().mockReturnValue([{ ref: "cloud-a" }]),
      probeRemote: jest.fn().mockResolvedValue({
        compatible: true,
        deploymentDigest: "wfv1:abc",
        activeUnits: 1,
        maxUnits: 8,
      }),
      enqueueHandoff: jest.fn().mockResolvedValue(queueRow("cloud-a")),
    })

    await expect(
      dispatchPlacedWorkflowTrigger({ event, idempotencyKey: "trigger-key", onAdmitted }, d)
    ).resolves.toEqual({ kind: "remote", dispatchId: "dispatch-1", targetRef: "cloud-a" })

    expect(d.probeRemote).not.toHaveBeenCalled()
    expect(d.enqueueHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "schedule-handoff",
        targetRef: "cloud-a",
        idempotencyKey: "trigger-key",
        payload: expect.objectContaining({
          deploymentId: "deployment-1",
          expectedVersionDigest: "wfv1:abc",
          trigger: event,
        }),
      })
    )
    expect(onAdmitted).toHaveBeenCalledWith("dispatch-1")
    expect(d.executeLocal).not.toHaveBeenCalled()
  })

  it("executes locally when a pinned stable Host identity names this Host", async () => {
    const d = deps(resolved({ mode: "pinned", ref: "cloud-stable" }), {
      localHostRef: () => "cloud-stable",
    })

    await expect(
      dispatchPlacedWorkflowTrigger({ event, idempotencyKey: "trigger-key" }, d)
    ).resolves.toEqual({ kind: "local", runId: "run-local" })
    expect(d.executeLocal).toHaveBeenCalledTimes(1)
    expect(d.listRemoteHosts).not.toHaveBeenCalled()
    expect(d.enqueueHandoff).not.toHaveBeenCalled()
  })

  it("auto-selects the least-loaded exact-version Host", async () => {
    const d = deps(resolved({ mode: "auto" }), {
      getLocalActiveUnits: jest.fn().mockResolvedValue(3),
      listRemoteHosts: jest.fn().mockReturnValue([{ ref: "cloud-b" }, { ref: "cloud-a" }]),
      probeRemote: jest.fn(async (ref: string) => ({
        compatible: true,
        deploymentDigest: "wfv1:abc",
        activeUnits: ref === "cloud-a" ? 1 : 2,
        maxUnits: 8,
      })),
      enqueueHandoff: jest.fn(async (input: { targetRef: string }) => queueRow(input.targetRef)),
    })

    await expect(
      dispatchPlacedWorkflowTrigger({ event, idempotencyKey: "trigger-key" }, d)
    ).resolves.toMatchObject({ kind: "remote", targetRef: "cloud-a" })
  })

  it("durably waits for a pinned Host whose deployment is temporarily different", async () => {
    const d = deps(resolved({ mode: "pinned", ref: "cloud-a" }), {
      listRemoteHosts: jest.fn().mockReturnValue([{ ref: "cloud-a" }]),
      probeRemote: jest.fn().mockResolvedValue({
        compatible: false,
        deploymentDigest: "wfv1:different",
        activeUnits: 0,
        maxUnits: 8,
      }),
      enqueueHandoff: jest.fn().mockResolvedValue(queueRow("cloud-a")),
    })

    await expect(
      dispatchPlacedWorkflowTrigger({ event, idempotencyKey: "trigger-key" }, d)
    ).resolves.toMatchObject({ kind: "remote", targetRef: "cloud-a" })
    expect(d.probeRemote).not.toHaveBeenCalled()
    expect(d.enqueueHandoff).toHaveBeenCalledTimes(1)
  })

  it("persists a pinned occurrence before an unreachable Host can drop it", async () => {
    const d = deps(resolved({ mode: "pinned", ref: "cloud-a" }), {
      listRemoteHosts: jest.fn().mockResolvedValue([{ ref: "cloud-a" }]),
      probeRemote: jest.fn().mockRejectedValue(new Error("offline")),
      enqueueHandoff: jest.fn().mockResolvedValue(queueRow("cloud-a")),
    })

    await expect(
      dispatchPlacedWorkflowTrigger({ event, idempotencyKey: "trigger-key" }, d)
    ).resolves.toMatchObject({ kind: "remote", targetRef: "cloud-a" })
    expect(d.probeRemote).not.toHaveBeenCalled()
  })

  it("falls back to local execution when auto placement selects the local Host", async () => {
    const d = deps(resolved({ mode: "auto" }), {
      getLocalActiveUnits: jest.fn().mockResolvedValue(0),
      listRemoteHosts: jest.fn().mockReturnValue([{ ref: "cloud-a" }]),
      probeRemote: jest.fn().mockResolvedValue({
        compatible: true,
        deploymentDigest: "wfv1:abc",
        activeUnits: 7,
        maxUnits: 8,
      }),
    })

    await expect(
      dispatchPlacedWorkflowTrigger({ event, idempotencyKey: "trigger-key" }, d)
    ).resolves.toEqual({ kind: "local", runId: "run-local" })
    expect(d.enqueueHandoff).not.toHaveBeenCalled()
  })

  it("excludes a remote Host that omits the exact deployment digest", async () => {
    const d = deps(resolved({ mode: "auto" }), {
      getLocalActiveUnits: jest.fn().mockResolvedValue(0),
      listRemoteHosts: jest.fn().mockReturnValue([{ ref: "cloud-a" }]),
      probeRemote: jest.fn().mockResolvedValue({
        compatible: true,
        activeUnits: 0,
        maxUnits: 8,
      }),
    })

    await expect(dispatchPlacedWorkflowTrigger({ event }, d)).resolves.toEqual({
      kind: "local",
      runId: "run-local",
    })
  })

  it("mints one durable queue key for a single-Host trigger without a shared ledger key", async () => {
    const d = deps(resolved({ mode: "pinned", ref: "cloud-a" }), {
      listRemoteHosts: jest.fn().mockReturnValue([{ ref: "cloud-a" }]),
      probeRemote: jest.fn().mockResolvedValue({
        compatible: true,
        deploymentDigest: "wfv1:abc",
        activeUnits: 0,
        maxUnits: 8,
      }),
      enqueueHandoff: jest.fn(async (input: { targetRef: string }) => queueRow(input.targetRef)),
    })

    await dispatchPlacedWorkflowTrigger({ event }, d)

    expect(d.enqueueHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^workflow-handoff:/),
      })
    )
  })

  it("uses the production adapters for local draft execution", async () => {
    jest.mocked(resolveWorkflowDeployment).mockResolvedValue(undefined)
    jest.mocked(executeDeployedWorkflow).mockResolvedValue({
      runId: "run-default",
    } as Awaited<ReturnType<typeof executeDeployedWorkflow>>)

    await expect(dispatchPlacedWorkflowTrigger({ event })).resolves.toEqual({
      kind: "local",
      runId: "run-default",
    })
    expect(resolveWorkflowDeployment).toHaveBeenCalledWith("workflow-1")
    expect(executeDeployedWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "workflow-1", entrypoint: "trigger" })
    )
  })

  it("uses the headless Host identity from the production environment", async () => {
    process.env.COGNIA_HOST_ID = "cloud-stable"
    jest
      .mocked(resolveWorkflowDeployment)
      .mockResolvedValue(resolved({ mode: "pinned", ref: "cloud-stable" }))
    jest.mocked(executeDeployedWorkflow).mockResolvedValue({
      runId: "run-self",
    } as Awaited<ReturnType<typeof executeDeployedWorkflow>>)

    await expect(dispatchPlacedWorkflowTrigger({ event })).resolves.toEqual({
      kind: "local",
      runId: "run-self",
    })
    expect(enqueueHostDispatch).not.toHaveBeenCalled()
  })

  it("discovers capable Hosts, probes capacity, and enqueues through production adapters", async () => {
    const close = jest.fn()
    const call = jest.fn().mockResolvedValue({
      compatible: true,
      deploymentDigest: "wfv1:abc",
      activeUnits: -2,
      maxUnits: 0,
    })
    jest.mocked(resolveWorkflowDeployment).mockResolvedValue(
      resolved({
        mode: "auto",
      })
    )
    jest.mocked(getDb).mockReturnValue({
      workflowRuns: {
        where: jest.fn(() => ({
          equals: jest.fn(() => ({
            filter: jest.fn(() => ({ count: jest.fn().mockResolvedValue(3) })),
          })),
        })),
      },
    } as unknown as ReturnType<typeof getDb>)
    useRemoteHostStore.setState({
      activeHostId: null,
      hosts: [
        {
          id: "cloud-row",
          label: "Cloud",
          credentialRef: "remote-host:cloud-row",
          addedAt: 1,
          connectionState: "ready",
          config: { baseUrl: "https://cloud.example", deviceId: "device" },
          featureManifest: {
            schemaVersion: 2,
            hostBuildId: "build",
            platform: "headless",
            generatedAt: 1,
            hostIdentity: { id: "cloud-stable", kind: "cloud" },
            protocol: { min: 1, max: 2 },
            operations: [
              {
                name: "workflow_placement_probe",
                feature: "workflow.execution",
                featureVersion: 1,
                healthy: true,
              },
              {
                name: "workflow_handoff_create",
                feature: "workflow.execution",
                featureVersion: 1,
                healthy: true,
              },
            ],
            deviceGrants: [],
            features: {
              "workflow.execution": {
                version: 1,
                operations: ["workflow_placement_probe", "workflow_handoff_create"],
              },
            },
            limits: {
              rpcJsonBodyBytes: 1,
              skillMaxResources: 1,
              skillMaxResourceBytes: 1,
              skillUploadChunkBytes: 1,
              mcpRequestBodyBytes: 1,
              maxConcurrentProxyCalls: 1,
            },
          },
        },
        {
          id: "legacy-row",
          label: "Legacy",
          credentialRef: "remote-host:legacy-row",
          addedAt: 1,
          connectionState: "ready",
          config: { baseUrl: "https://legacy.example", deviceId: "legacy" },
        },
      ],
    })
    jest.mocked(openRemoteHostTarget).mockResolvedValue({
      host: useRemoteHostStore.getState().hosts[0]!,
      transport: { call, subscribe: jest.fn(() => () => undefined) },
      close,
    })
    jest.mocked(enqueueHostDispatch).mockResolvedValue(queueRow("cloud-stable"))

    await expect(
      dispatchPlacedWorkflowTrigger({ event, idempotencyKey: "production-key" })
    ).resolves.toEqual({
      kind: "remote",
      dispatchId: "dispatch-1",
      targetRef: "cloud-stable",
    })
    expect(call).toHaveBeenCalledWith("workflow_placement_probe", {
      deploymentId: "deployment-1",
      expectedVersionDigest: "wfv1:abc",
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(enqueueHostDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-default", targetRef: "cloud-stable" })
    )
  })

  it("fails a production probe closed when a Host returns malformed capacity", async () => {
    jest.mocked(resolveWorkflowDeployment).mockResolvedValue(resolved({ mode: "auto" }))
    jest.mocked(getDb).mockReturnValue({
      workflowRuns: {
        where: jest.fn(() => ({
          equals: jest.fn(() => ({
            filter: jest.fn(() => ({ count: jest.fn().mockResolvedValue(0) })),
          })),
        })),
      },
    } as unknown as ReturnType<typeof getDb>)
    useRemoteHostStore.setState({
      hosts: [
        {
          id: "cloud-row",
          label: "Cloud",
          credentialRef: "remote-host:cloud-row",
          addedAt: 1,
          connectionState: "ready",
          config: { baseUrl: "https://cloud.example", deviceId: "device" },
          featureManifest: {
            schemaVersion: 2,
            hostBuildId: "build",
            platform: "headless",
            generatedAt: 1,
            hostIdentity: { id: "cloud-stable", kind: "cloud" },
            protocol: { min: 1, max: 2 },
            operations: [
              {
                name: "workflow_placement_probe",
                feature: "workflow.execution",
                featureVersion: 1,
                healthy: true,
              },
              {
                name: "workflow_handoff_create",
                feature: "workflow.execution",
                featureVersion: 1,
                healthy: true,
              },
            ],
            deviceGrants: [],
            features: {
              "workflow.execution": {
                version: 1,
                operations: ["workflow_placement_probe", "workflow_handoff_create"],
              },
            },
            limits: {
              rpcJsonBodyBytes: 1,
              skillMaxResources: 1,
              skillMaxResourceBytes: 1,
              skillUploadChunkBytes: 1,
              mcpRequestBodyBytes: 1,
              maxConcurrentProxyCalls: 1,
            },
          },
        },
      ],
    })
    const close = jest.fn()
    jest.mocked(openRemoteHostTarget).mockResolvedValue({
      host: useRemoteHostStore.getState().hosts[0]!,
      transport: {
        call: jest.fn().mockResolvedValue({ compatible: true, activeUnits: "many" }),
        subscribe: jest.fn(() => () => undefined),
      },
      close,
    })

    jest.mocked(executeDeployedWorkflow).mockResolvedValue({
      runId: "run-local-after-malformed-probe",
    } as Awaited<ReturnType<typeof executeDeployedWorkflow>>)

    await expect(dispatchPlacedWorkflowTrigger({ event })).resolves.toEqual({
      kind: "local",
      runId: "run-local-after-malformed-probe",
    })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
