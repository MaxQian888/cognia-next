import type { ProjectEnvironmentVersion } from "@/types/project-environment"
import type { WorkspaceBundleTurnLease } from "@/lib/task-workspace/run-lease"
import type { WorkspaceBundle } from "@/lib/task-workspace/types"
import { createLocalTauriExecutionEnvironment } from "./local-tauri-environment"

const profile = (
  overrides: Partial<ProjectEnvironmentVersion> = {}
): ProjectEnvironmentVersion => ({
  id: "env-v1",
  environmentId: "env-1",
  projectId: "project-1",
  version: 1,
  name: "Development",
  setupScript: { default: "pnpm install" },
  actions: [],
  variables: {},
  keyringReferences: [],
  policy: { requiredRuntimeCapabilities: ["filesystem", "process", "terminal", "editor"] },
  createdAt: 1,
  ...overrides,
})

describe("local Tauri AgentTeam execution environment", () => {
  it("rejects duplicate child opens while the first workspace is still opening", async () => {
    let resolveOpen!: (workspace: { executionRoot: string; settle: jest.Mock }) => void
    const settle = jest.fn().mockResolvedValue([])
    const openWorkspace = jest.fn(
      () =>
        new Promise<{ executionRoot: string; settle: jest.Mock }>((resolve) => {
          resolveOpen = resolve
        })
    )
    const environment = createLocalTauriExecutionEnvironment({
      executeSetup: async () => ({ success: true }),
      openWorkspace,
    })
    const prepared = await environment.prepare(profile(), "/repo")
    const input = {
      runId: "run",
      childRunId: "child",
      taskId: "task",
      teammateId: "mate",
      repositoryPath: "/repo",
      profile: prepared,
    }
    const first = environment.openChild(input)
    const duplicate = environment.openChild(input)
    // Resolve the most recent acquisition so a duplicate acquisition fails explicitly.
    resolveOpen({ executionRoot: "/worktree", settle })
    await expect(duplicate).rejects.toThrow(/already open/i)
    await first
    await expect(environment.openChild(input)).rejects.toThrow(/already open/i)
    expect(openWorkspace).toHaveBeenCalledTimes(1)
    await environment.dispose("child")
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it("cannot revive a terminated child by suspending it before resume", async () => {
    const environment = createLocalTauriExecutionEnvironment({
      executeSetup: async () => ({ success: true }),
      openWorkspace: async () => ({ executionRoot: "/worktree", settle: async () => [] }),
    })
    const prepared = await environment.prepare(profile(), "/repo")
    await environment.openChild({
      runId: "run",
      childRunId: "child",
      taskId: "task",
      teammateId: "mate",
      repositoryPath: "/repo",
      profile: prepared,
    })
    await environment.terminate("child")
    await expect(environment.suspend("child")).rejects.toThrow(/terminated/i)
    await expect(environment.resume("child")).rejects.toThrow(/terminated/i)
    expect(environment.resourceHealth("child")?.state).toBe("terminated")
    await environment.dispose("child")
  })
  it("retries a failed settlement with its original failed state during disposal", async () => {
    const settle = jest
      .fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValue([])
    const environment = createLocalTauriExecutionEnvironment({
      executeSetup: async () => ({ success: true }),
      openWorkspace: async () => ({ executionRoot: "/worktree", settle }),
    })
    const prepared = await environment.prepare(profile(), "/repo")
    const child = await environment.openChild({
      runId: "run",
      childRunId: "child",
      taskId: "task",
      teammateId: "mate",
      repositoryPath: "/repo",
      profile: prepared,
    })
    await expect(child.settle("failed")).rejects.toThrow("storage unavailable")
    await environment.dispose("child")
    expect(settle.mock.calls).toEqual([["failed"], ["failed"]])
    expect(environment.resourceHealth("child")).toBeNull()
  })

  it("shares concurrent settlement and retries failed cancellation during disposal", async () => {
    let rejectSettlement!: (error: Error) => void
    const settle = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectSettlement = reject
          })
      )
      .mockResolvedValue([])
    const environment = createLocalTauriExecutionEnvironment({
      executeSetup: async () => ({ success: true }),
      openWorkspace: async () => ({ executionRoot: "/worktree", settle }),
    })
    const prepared = await environment.prepare(profile(), "/repo")
    const child = await environment.openChild({
      runId: "run",
      childRunId: "child",
      taskId: "task",
      teammateId: "mate",
      repositoryPath: "/repo",
      profile: prepared,
    })
    const first = environment.terminate("child")
    const concurrent = child.settle("ready")
    const failures = Promise.allSettled([first, concurrent])
    expect(settle).toHaveBeenCalledTimes(1)
    rejectSettlement(new Error("storage unavailable"))
    expect((await failures).every((result) => result.status === "rejected")).toBe(true)
    expect(environment.resourceHealth("child")?.state).toBe("terminated")
    await environment.dispose("child")
    expect(settle.mock.calls).toEqual([["cancelled"], ["cancelled"]])
    expect(environment.resourceHealth("child")).toBeNull()
  })

  it("does not advertise unproven confinement or egress capabilities", () => {
    const environment = createLocalTauriExecutionEnvironment()
    expect(environment.capabilities().has("sandbox")).toBe(false)
    expect(environment.capabilities().has("network_policy")).toBe(false)
    expect(
      environment.preflight(
        profile({ policy: { requiredRuntimeCapabilities: [], network: "off" } })
      )
    ).toEqual({ ok: false, missing: ["network_policy", "sandbox"] })
  })

  it("probes the host before admitting a restricted profile, including an empty setup", async () => {
    const executeSetup = jest.fn(async () => ({ success: true }))
    const probeConfinement = jest.fn(async () => ({ confined: false }))
    const environment = createLocalTauriExecutionEnvironment({ executeSetup, probeConfinement })
    const secured = profile({
      setupScript: { default: "" },
      policy: { requiredRuntimeCapabilities: [], network: "off" },
    })
    await expect(environment.prepare(secured, "/repo")).rejects.toThrow("network_policy, sandbox")
    expect(executeSetup).not.toHaveBeenCalled()
    probeConfinement.mockResolvedValue({ confined: true })
    await expect(environment.prepare(secured, "/repo")).resolves.toMatchObject({
      executionRoot: "/repo",
    })
    expect(environment.capabilities().has("sandbox")).toBe(true)
    expect(executeSetup).toHaveBeenCalledTimes(1)
  })

  it("fails closed when a requested policy cannot be enforced", async () => {
    const environment = createLocalTauriExecutionEnvironment({
      isTauri: () => true,
      sandboxSupported: false,
      networkPolicySupported: false,
    })
    const secured = profile({
      policy: {
        requiredRuntimeCapabilities: ["filesystem", "sandbox", "network_policy"],
        requireSandbox: true,
        allowedDomains: ["api.github.com"],
      },
    })

    await expect(environment.prepare(secured, "/repo")).rejects.toThrow(/network_policy, sandbox/)
  })

  it("prepares an immutable environment version and exposes takeover surfaces", async () => {
    const executeSetup = jest.fn(async () => ({ success: true, bypassed: false }))
    const resources: import("@/lib/task-workspace/types").ResourceChange[] = [
      {
        runId: "workspace-run-1",
        path: "src/index.ts",
        kind: "modified",
        oldPath: null,
        origin: "agent",
        agentId: "mate-1",
        mediaType: "text/typescript",
        size: 1,
        hash: null,
        beforeHash: null,
        insertions: 1,
        deletions: 0,
        binary: false,
        resourceKind: "file",
        beforeMode: null,
        afterMode: null,
        sensitive: false,
        revision: 1,
        captureClass: "source",
        contentCaptured: true,
      },
    ]
    const settle = jest.fn(async () => resources)
    const acquireWorkspaceBundle = jest.fn(async () => ({
      bundleId: "bundle-1",
      environmentKind: "managed" as const,
      ownerType: "team" as const,
      ownerRef: "run-1",
      state: "active" as const,
      leases: [
        {
          bundleId: "bundle-1",
          workspaceId: "workspace-1",
          logicalRootId: "primary",
          role: "primary" as const,
          aliasPath: "/worktrees/child-1",
        },
      ],
      lastUsedAt: 1,
      pinned: false,
      createdAt: 1,
    }))
    const openWorkspaceBundleTurnLease = jest.fn(
      async () =>
        ({
          bundleTurnId: "bundle-turn-1",
          bundleId: "bundle-1",
          run: {
            taskId: "task-1",
            parentRunId: null,
            agentId: "mate-1",
            agentKind: "agent-team",
            workspaceId: "workspace-1",
            base: { kind: "remoteDefault" },
            workspaceKey: null,
            executionRunId: null,
            traceId: null,
            turnId: null,
            attemptId: null,
            providerAttemptId: null,
            surface: null,
            trackingPolicy: { generatedOutputRoots: [], autoDetect: true },
            baselineRevision: 0,
            state: "running",
            createdAt: 1,
            settledAt: null,
            runId: "workspace-run-1",
            executionRoot: "/worktrees/child-1",
            isolationKind: "gitWorktree" as const,
            isolationRef: "codex/child-1",
          },
          runs: [],
          primaryAlias: "/worktrees/child-1",
          additionalAliases: [],
          settle,
          abort: jest.fn(),
        }) satisfies WorkspaceBundleTurnLease
    )
    const environment = createLocalTauriExecutionEnvironment({
      isTauri: () => true,
      sandboxSupported: true,
      networkPolicySupported: true,
      executeSetup,
      acquireWorkspaceBundle,
      openWorkspaceBundleTurnLease,
    })

    const prepared = await environment.prepare(profile(), "/repo")
    const child = await environment.openChild({
      runId: "run-1",
      childRunId: "child-1",
      taskId: "task-1",
      teammateId: "mate-1",
      repositoryPath: "/repo",
      profile: prepared,
    })

    expect(executeSetup).toHaveBeenCalledWith(profile(), "/repo")
    expect(acquireWorkspaceBundle).toHaveBeenCalledWith({
      ownerType: "team",
      ownerRef: "run-1",
      environmentKind: "managed",
      base: { kind: "remoteDefault" },
      roots: [
        {
          logicalRootId: "primary",
          role: "primary",
          sourceRoot: "/repo",
        },
      ],
    })
    expect(openWorkspaceBundleTurnLease).toHaveBeenCalledWith(
      expect.objectContaining({ bundleId: "bundle-1" }),
      "primary",
      {
        taskId: "task-1",
        sessionId: "run-1",
        runId: "child-1",
        executionRunId: "run-1",
        turnId: "child-1",
        attemptId: "a1",
        surface: "agent-team-durable",
        agentId: "mate-1",
        agentKind: "agent-team",
        workspaceRoot: "/repo",
      }
    )
    expect(child.executionRoot).toBe("/worktrees/child-1")
    expect(child.branch).toBe("codex/child-1")
    expect(environment.getInteractiveSurfaces("child-1")).toEqual({
      terminal: { cwd: "/worktrees/child-1", sessionScope: "child-1" },
      editor: { root: "/worktrees/child-1" },
      browser: { sessionScope: "child-1" },
    })
    await expect(child.settle("ready")).resolves.toEqual(resources)
    await environment.dispose("child-1")
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it("fails closed when Registry Bundle acquisition fails", async () => {
    const openWorkspaceBundleTurnLease = jest.fn()
    const environment = createLocalTauriExecutionEnvironment({
      executeSetup: async () => ({ success: true }),
      acquireWorkspaceBundle: async () => {
        throw new Error("Registry unavailable")
      },
      openWorkspaceBundleTurnLease,
    })
    const prepared = await environment.prepare(profile(), "/repo")

    await expect(
      environment.openChild({
        runId: "run-1",
        childRunId: "child-1",
        taskId: "task-1",
        teammateId: "mate-1",
        repositoryPath: "/repo",
        profile: prepared,
      })
    ).rejects.toThrow("Registry unavailable")
    expect(openWorkspaceBundleTurnLease).not.toHaveBeenCalled()
    expect(environment.getInteractiveSurfaces("child-1")).toBeNull()
  })

  it("fails closed when Registry does not open a Bundle Turn", async () => {
    const environment = createLocalTauriExecutionEnvironment({
      executeSetup: async () => ({ success: true }),
      acquireWorkspaceBundle: async () =>
        ({
          bundleId: "bundle-1",
          environmentKind: "managed",
          ownerType: "team",
          ownerRef: "run-1",
          state: "active",
          leases: [],
          lastUsedAt: 1,
          pinned: false,
          createdAt: 1,
        }) satisfies WorkspaceBundle,
      openWorkspaceBundleTurnLease: async () => null,
    })
    const prepared = await environment.prepare(profile(), "/repo")

    await expect(
      environment.openChild({
        runId: "run-1",
        childRunId: "child-1",
        taskId: "task-1",
        teammateId: "mate-1",
        repositoryPath: "/repo",
        profile: prepared,
      })
    ).rejects.toThrow("Registry did not return a Bundle Turn execution root")
    expect(environment.getInteractiveSurfaces("child-1")).toBeNull()
  })

  it("uses the host-neutral execution transport outside Tauri", async () => {
    const executeSetup = jest.fn(async () => ({ success: true }))
    const environment = createLocalTauriExecutionEnvironment({
      isTauri: () => false,
      executeSetup,
    })
    await expect(environment.prepare(profile(), "/repo")).resolves.toEqual(
      expect.objectContaining({ executionRoot: "/repo" })
    )
    expect(executeSetup).toHaveBeenCalledWith(profile(), "/repo")
  })
})
