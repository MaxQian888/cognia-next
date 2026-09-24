import {
  __resetRemoteWorkerRuntimeForTesting,
  isRemoteWorkerDispatchAvailable,
  subscribeToRemoteWorkerRuntime,
  evaluateRemoteWorkerPlacement,
  getRemoteWorkerRuntime,
  installRemoteWorkerRuntime,
  RemoteWorkerWaitingError,
  selectRemoteWorker,
  type RemoteWorkerDescriptor,
} from "./remote-worker-runtime"
import type { ResolvedAgentExecutionSpec } from "@cognia/agent-config-types/agent-execution"

const executionSpec: ResolvedAgentExecutionSpec = {
  specVersion: 2,
  identity: { sessionId: "session", runId: "run", attemptId: "a1" },
  executionFingerprint: "aexf1-test",
  executionKind: "agent",
  runtimeAdapter: "external",
  runtimePolicySource: "legacy-mapped",
  deploymentRef: "provider:anthropic",
  modelBindings: { primary: "claude-sonnet" },
  route: { kind: "direct", routePolicy: "direct" },
  hostRef: "headless-agent-host",
  compatibility: { evidence: "native" },
  capabilities: { effective: ["streaming"], disabledOptional: [] },
  credential: {
    profileRef: "credential:anthropic",
    affinity: "sticky-with-failover",
  },
  fallbackPolicy: "none",
}

function worker(
  hostRef: string,
  overrides: Partial<RemoteWorkerDescriptor> = {}
): RemoteWorkerDescriptor {
  return {
    connectionId: `connection:${hostRef}`,
    hostRef,
    online: true,
    activeTurns: 0,
    lastSeenAt: 1,
    manifest: {
      manifestVersion: 1,
      runtime: "cognia-agent",
      models: ["claude-sonnet"],
      hardCapabilities: ["tools", "sandbox:filesystem"],
      maxActiveTurns: 1,
      credentialProfileRefs: ["credential:anthropic"],
      workspaceBindingRefs: ["repository:project:repo"],
      taskWorkspace: { enabled: true },
      sandbox: { capabilities: ["filesystem"] },
      platform: { os: "linux", arch: "x64" },
      executionProfile: {
        profileVersion: 1,
        backendId: "cognia-agent",
        runtimeAdapter: "external",
        modelBindings: { primary: "claude-sonnet" },
        deploymentRefs: ["provider:anthropic"],
        capabilities: ["streaming"],
      },
    },
    ...overrides,
  }
}

describe("remote AgentTeam worker selection", () => {
  const requirements = {
    spec: executionSpec,
    workspaceBindingRef: "repository:project:repo",
    requiredSandboxCapabilities: ["filesystem"],
  }

  it("selects the lowest load and breaks ties by stable authenticated hostRef", () => {
    const selected = selectRemoteWorker(
      [worker("device:b"), worker("device:a"), worker("device:c", { activeTurns: 1 })],
      { mode: "auto" },
      requirements
    )
    expect(selected.hostRef).toBe("device:a")
    expect(
      selectRemoteWorker(
        [worker("device:a")],
        { mode: "pinned", hostRef: "device:a" },
        requirements
      ).hostRef
    ).toBe("device:a")
  })

  it("carries the pinned target's specific reason, not a generic mismatch", () => {
    // Selection now delegates ordering and the tiebreak to the shared placement
    // layer, whose vocabulary is deliberately narrower. The eleven worker
    // reasons are persisted on `AgentTeamChildRun.placementReason`, so they have
    // to survive the round trip rather than collapsing into one value.
    try {
      selectRemoteWorker(
        [worker("device:b", { activeTurns: 1 })],
        { mode: "pinned", hostRef: "device:b" },
        requirements
      )
      throw new Error("expected the incompatible pinned worker to wait")
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteWorkerWaitingError)
      expect(error).toMatchObject({
        reason: "no_compatible_capacity",
        hostRef: "device:b",
        placementReason: "capacity_exhausted",
      })
    }
  })

  it("keeps an offline pinned target waiting instead of migrating", () => {
    try {
      selectRemoteWorker(
        [worker("device:a"), worker("device:b", { online: false })],
        { mode: "pinned", hostRef: "device:b" },
        requirements
      )
      throw new Error("expected the offline pinned worker to wait")
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteWorkerWaitingError)
      expect(error).toMatchObject({ reason: "pinned_host_offline", hostRef: "device:b" })
    }
    try {
      selectRemoteWorker(
        [worker("device:a")],
        { mode: "pinned", hostRef: "device:missing" },
        requirements
      )
    } catch (error) {
      expect(error).toMatchObject({ reason: "pinned_host_offline" })
    }
  })

  it("fails closed before dispatch when capability, credential, workspace, or slots differ", () => {
    const candidates = [
      worker("device:cap", {
        manifest: {
          ...worker("x").manifest,
          executionProfile: { ...worker("x").manifest.executionProfile!, capabilities: [] },
        },
      }),
      worker("device:credential", {
        manifest: { ...worker("x").manifest, credentialProfileRefs: [] },
      }),
      worker("device:workspace", {
        manifest: { ...worker("x").manifest, workspaceBindingRefs: [] },
      }),
      worker("device:sandbox", {
        manifest: { ...worker("x").manifest, sandbox: { capabilities: [] } },
      }),
      worker("device:full", { activeTurns: 1 }),
    ]
    expect(() => selectRemoteWorker(candidates, { mode: "auto" }, requirements)).toThrow(
      expect.objectContaining({ reason: "no_compatible_capacity" })
    )
  })

  it.each([
    ["worker_offline", { online: false }],
    [
      "execution_profile_missing",
      { manifest: { ...worker("x").manifest, executionProfile: undefined } },
    ],
    [
      "runtime_mismatch",
      {
        manifest: {
          ...worker("x").manifest,
          executionProfile: {
            ...worker("x").manifest.executionProfile!,
            runtimeAdapter: "ai-sdk" as const,
          },
        },
      },
    ],
    [
      "model_mismatch",
      {
        manifest: {
          ...worker("x").manifest,
          executionProfile: {
            ...worker("x").manifest.executionProfile!,
            modelBindings: { primary: "other" },
          },
        },
      },
    ],
    [
      "deployment_mismatch",
      {
        manifest: {
          ...worker("x").manifest,
          executionProfile: {
            ...worker("x").manifest.executionProfile!,
            deploymentRefs: [],
          },
        },
      },
    ],
    [
      "capability_mismatch",
      {
        manifest: {
          ...worker("x").manifest,
          executionProfile: { ...worker("x").manifest.executionProfile!, capabilities: [] },
        },
      },
    ],
    ["credential_missing", { manifest: { ...worker("x").manifest, credentialProfileRefs: [] } }],
    [
      "task_workspace_unavailable",
      { manifest: { ...worker("x").manifest, taskWorkspace: { enabled: false } } },
    ],
    ["workspace_missing", { manifest: { ...worker("x").manifest, workspaceBindingRefs: [] } }],
    ["sandbox_mismatch", { manifest: { ...worker("x").manifest, sandbox: { capabilities: [] } } }],
    ["capacity_exhausted", { activeTurns: 1 }],
  ])("reports %s without collapsing placement diagnostics", (reason, overrides) => {
    expect(evaluateRemoteWorkerPlacement(worker("device:test", overrides), requirements)).toEqual({
      ready: false,
      reason,
    })
  })

  it("accepts inherit-only specs without deployment, credential, or sandbox requirements", () => {
    const spec: ResolvedAgentExecutionSpec = {
      ...executionSpec,
      deploymentRef: undefined,
      modelBindings: { primary: "inherit", fast: undefined },
      credential: undefined,
      capabilities: { effective: [], disabledOptional: [] },
    }
    expect(
      evaluateRemoteWorkerPlacement(worker("device:test"), {
        spec,
        workspaceBindingRef: "repository:project:repo",
        requiredSandboxCapabilities: [],
      })
    ).toEqual({ ready: true })
  })

  it("keeps the remote runtime registry narrow and cleanup-safe", () => {
    __resetRemoteWorkerRuntimeForTesting()
    const first = { listWorkers: jest.fn(() => []), run: jest.fn() }
    const second = { listWorkers: jest.fn(() => []), run: jest.fn() }
    const uninstallFirst = installRemoteWorkerRuntime(first as never)
    const uninstallSecond = installRemoteWorkerRuntime(second as never)
    expect(getRemoteWorkerRuntime()).toBe(second)
    uninstallFirst()
    expect(getRemoteWorkerRuntime()).toBe(second)
    uninstallSecond()
    expect(getRemoteWorkerRuntime()).toBeUndefined()
  })

  it("publishes dispatch availability so a host can say it is inert", () => {
    // Whether a brain is attached is the difference between a worker that will
    // receive frames and one that never will. Fleet reads this rather than
    // inferring capability from a successful enrollment.
    __resetRemoteWorkerRuntimeForTesting()
    const listener = jest.fn()
    const unsubscribe = subscribeToRemoteWorkerRuntime(listener)
    expect(isRemoteWorkerDispatchAvailable()).toBe(false)

    const uninstall = installRemoteWorkerRuntime({
      listWorkers: jest.fn(() => []),
      run: jest.fn(),
    } as never)
    expect(isRemoteWorkerDispatchAvailable()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    uninstall()
    expect(isRemoteWorkerDispatchAvailable()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    installRemoteWorkerRuntime({ listWorkers: jest.fn(() => []), run: jest.fn() } as never)
    expect(listener).toHaveBeenCalledTimes(2)
    __resetRemoteWorkerRuntimeForTesting()
  })

  it("does not notify when a stale uninstall loses the race to a newer runtime", () => {
    // A WebView reload installs a new pool before the old one's cleanup runs.
    // Firing "unavailable" there would flash the inert warning over a host that
    // is in fact dispatching.
    __resetRemoteWorkerRuntimeForTesting()
    const uninstallFirst = installRemoteWorkerRuntime({
      listWorkers: jest.fn(() => []),
      run: jest.fn(),
    } as never)
    const second = { listWorkers: jest.fn(() => []), run: jest.fn() }
    installRemoteWorkerRuntime(second as never)

    const listener = jest.fn()
    const unsubscribe = subscribeToRemoteWorkerRuntime(listener)
    uninstallFirst()

    expect(listener).not.toHaveBeenCalled()
    expect(getRemoteWorkerRuntime()).toBe(second)
    unsubscribe()
    __resetRemoteWorkerRuntimeForTesting()
  })
})
