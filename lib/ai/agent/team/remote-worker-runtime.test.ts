import {
  __resetRemoteWorkerRuntimeForTesting,
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

  it("keeps an offline pinned target waiting instead of migrating", () => {
    expect(() =>
      selectRemoteWorker(
        [worker("device:a"), worker("device:b", { online: false })],
        { mode: "pinned", hostRef: "device:b" },
        requirements
      )
    ).toThrow(RemoteWorkerWaitingError)
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
})
