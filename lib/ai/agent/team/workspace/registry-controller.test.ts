import type {
  AcquireWorkspaceBundle,
  WorkspaceBundle,
  WorkspaceBundleTurnLease,
} from "@/lib/task-workspace/types"
import { AgentTeamRegistryWorkspaceController } from "./registry-controller"

function bundle(id: string, primaryId: string): WorkspaceBundle {
  return {
    bundleId: id,
    environmentKind: "managed",
    ownerType: "team",
    ownerRef: "run-1",
    state: "active",
    leases: [
      {
        bundleId: id,
        workspaceId: `workspace-${primaryId}`,
        logicalRootId: primaryId,
        role: "primary",
        aliasPath: `/managed/${id}/${primaryId}`,
      },
    ],
    lastUsedAt: 1,
    pinned: false,
    createdAt: 1,
  }
}

function turnLease(bundleId: string, rootId: string): WorkspaceBundleTurnLease {
  const run = {
    runId: `task-run-${bundleId}`,
    taskId: "task:team:run-1",
    sessionId: "run-1",
    parentRunId: null,
    agentId: "teammate-1",
    agentKind: "agent-team",
    workspaceRoot: `/repo/${rootId}`,
    executionRoot: `/managed/${bundleId}/${rootId}`,
    isolationKind: "gitWorktree" as const,
    isolationRef: null,
    workspaceId: `workspace-${rootId}`,
    base: { kind: "localHead" as const },
    workspaceKey: null,
    executionRunId: "run-1",
    traceId: null,
    turnId: null,
    attemptId: "a1",
    providerAttemptId: null,
    surface: "team",
    trackingPolicy: { generatedOutputRoots: [], autoDetect: true },
    baselineRevision: 0,
    state: "running" as const,
    createdAt: 1,
    settledAt: null,
  }
  return {
    bundleTurnId: `turn-${bundleId}`,
    bundleId,
    primaryLogicalRootId: rootId,
    primaryAlias: run.executionRoot,
    additionalAliases: [],
    runs: [{ workspaceId: `workspace-${rootId}`, logicalRootIds: [rootId], run }],
    state: "running",
    createdAt: 1,
    settledAt: null,
  }
}

function managedRecord(workspaceId: string, branch: string) {
  return {
    workspaceId,
    environmentKind: "managed" as const,
    ownerType: "team" as const,
    ownerRef: "run-1",
    state: "active" as const,
    sourceRoot: "/repo/app",
    gitCommonDir: "/repo/app/.git",
    base: { kind: "localHead" as const },
    head: "abc",
    branch,
    isolationKind: "gitWorktree" as const,
    executionRoot: `/managed/${workspaceId}`,
    snapshotTaskId: null,
    sizeBytes: null,
    lastUsedAt: 1,
    lockedBy: null,
    pinned: false,
    createdAt: 1,
  }
}

describe("AgentTeamRegistryWorkspaceController", () => {
  it("rejects an empty writable root set", () => {
    expect(
      () =>
        new AgentTeamRegistryWorkspaceController({
          runId: "run-1",
          base: { kind: "localHead" },
          roots: [],
        })
    ).toThrow(/at least one writable root/)
  })

  it("rejects duplicate logical root identities", () => {
    expect(
      () =>
        new AgentTeamRegistryWorkspaceController({
          runId: "run-1",
          base: { kind: "localHead" },
          roots: [
            { logicalRootId: "app", sourceRoot: "/repo/app" },
            { logicalRootId: "app", sourceRoot: "/repo/other" },
          ],
        })
    ).toThrow(/Duplicate Agent Team repository id/)
  })

  it("acquires one team-owned detached bundle per parallel dispatch", async () => {
    let sequence = 0
    const acquireBundle = jest.fn(async (input: AcquireWorkspaceBundle) =>
      bundle(
        `bundle-${++sequence}`,
        input.roots.find((root) => root.role === "primary")!.logicalRootId
      )
    )
    const openTurn = jest.fn(async (workspaceBundle, primaryLogicalRootId, _input) => ({
      ...turnLease(workspaceBundle.bundleId, primaryLogicalRootId),
      run: turnLease(workspaceBundle.bundleId, primaryLogicalRootId).runs[0].run,
      settle: jest.fn(async () => []),
      abort: jest.fn(async () => []),
    }))
    const controller = new AgentTeamRegistryWorkspaceController({
      runId: "run-1",
      base: { kind: "gitRef", gitRef: "release/1" },
      roots: [
        { logicalRootId: "app", sourceRoot: "/repo/app" },
        { logicalRootId: "docs", sourceRoot: "/repo/docs" },
      ],
      acquireBundle,
      openTurn,
    })

    await Promise.all([
      controller.openDispatch({
        taskId: "task-a",
        teammateId: "alice",
        repositoryId: "app",
        traceId: "trace-1",
        traceSpanId: "span-1",
      }),
      controller.openDispatch({ taskId: "task-b", teammateId: "bob", repositoryId: "docs" }),
    ])

    expect(acquireBundle).toHaveBeenCalledTimes(2)
    expect(acquireBundle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ownerType: "team",
        ownerRef: "run-1",
        environmentKind: "managed",
        base: { kind: "gitRef", gitRef: "release/1" },
        roots: [
          { logicalRootId: "app", role: "primary", sourceRoot: "/repo/app" },
          { logicalRootId: "docs", role: "additional", sourceRoot: "/repo/docs" },
        ],
      })
    )
    expect(acquireBundle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        roots: [
          { logicalRootId: "app", role: "additional", sourceRoot: "/repo/app" },
          { logicalRootId: "docs", role: "primary", sourceRoot: "/repo/docs" },
        ],
      })
    )
    expect(openTurn.mock.calls[0][2]).toMatchObject({
      traceId: "trace-1",
      traceSpanId: "span-1",
    })
  })

  it("reuses one Registry bundle for pipeline dispatches sharing a workspace key", async () => {
    const acquireBundle = jest.fn(async () => bundle("bundle-pipeline", "app"))
    const openTurn = jest.fn(async (workspaceBundle, primaryLogicalRootId, _input) => ({
      ...turnLease(workspaceBundle.bundleId, primaryLogicalRootId),
      run: turnLease(workspaceBundle.bundleId, primaryLogicalRootId).runs[0].run,
      settle: jest.fn(async () => []),
      abort: jest.fn(async () => []),
    }))
    const controller = new AgentTeamRegistryWorkspaceController({
      runId: "run-1",
      base: { kind: "localHead" },
      roots: [{ logicalRootId: "app", sourceRoot: "/repo/app" }],
      acquireBundle,
      openTurn,
    })

    await controller.openDispatch({
      taskId: "build",
      teammateId: "alice",
      repositoryId: "app",
      workspaceKey: "pipeline",
    })
    await controller.openDispatch({
      taskId: "test",
      teammateId: "bob",
      repositoryId: "app",
      workspaceKey: "pipeline",
    })

    expect(acquireBundle).toHaveBeenCalledTimes(1)
    expect(openTurn).toHaveBeenCalledTimes(2)
    expect(openTurn.mock.calls[0][2]).toMatchObject({ attemptId: "a1" })
    expect(openTurn.mock.calls[1][2]).toMatchObject({ attemptId: "a1" })
    expect(openTurn.mock.calls[0][2].turnId).not.toBe(openTurn.mock.calls[1][2].turnId)
  })

  it("fails closed when a dispatch targets a root outside the writable bundle", async () => {
    const acquireBundle = jest.fn()
    const controller = new AgentTeamRegistryWorkspaceController({
      runId: "run-1",
      base: { kind: "localHead" },
      roots: [{ logicalRootId: "app", sourceRoot: "/repo/app" }],
      acquireBundle,
      openTurn: jest.fn(),
    })

    await expect(
      controller.openDispatch({
        taskId: "task-a",
        teammateId: "alice",
        repositoryId: "readonly-docs",
      })
    ).rejects.toThrow(/not a writable Registry root/)
    expect(acquireBundle).not.toHaveBeenCalled()
  })

  it("opens a fresh tracked turn when the same dispatch is retried", async () => {
    const acquireBundle = jest.fn(async () => bundle("bundle-retry", "app"))
    const openTurn = jest.fn(async (workspaceBundle, primaryLogicalRootId, _input) => ({
      ...turnLease(workspaceBundle.bundleId, primaryLogicalRootId),
      run: turnLease(workspaceBundle.bundleId, primaryLogicalRootId).runs[0].run,
      settle: jest.fn(async () => []),
      abort: jest.fn(async () => []),
    }))
    const controller = new AgentTeamRegistryWorkspaceController({
      runId: "run-1",
      base: { kind: "localHead" },
      roots: [{ logicalRootId: "app", sourceRoot: "/repo/app" }],
      acquireBundle,
      openTurn,
    })
    const dispatch = { taskId: "build", teammateId: "alice", repositoryId: "app" }

    await controller.openDispatch(dispatch)
    await controller.openDispatch(dispatch)

    expect(acquireBundle).toHaveBeenCalledTimes(1)
    expect(openTurn.mock.calls[0][2]).toMatchObject({ attemptId: "a1" })
    expect(openTurn.mock.calls[1][2]).toMatchObject({ attemptId: "a2" })
    expect(openTurn.mock.calls[0][2].turnId).not.toBe(openTurn.mock.calls[1][2].turnId)
  })

  it("clears a failed acquisition so the same dispatch can retry", async () => {
    const acquireBundle = jest
      .fn()
      .mockRejectedValueOnce(new Error("host unavailable"))
      .mockResolvedValueOnce(bundle("bundle-recovered", "app"))
    const openTurn = jest.fn(async (workspaceBundle, primaryLogicalRootId, _input) => ({
      ...turnLease(workspaceBundle.bundleId, primaryLogicalRootId),
      run: turnLease(workspaceBundle.bundleId, primaryLogicalRootId).runs[0].run,
      settle: jest.fn(async () => []),
      abort: jest.fn(async () => []),
    }))
    const controller = new AgentTeamRegistryWorkspaceController({
      runId: "run-1",
      base: { kind: "localHead" },
      roots: [{ logicalRootId: "app", sourceRoot: "/repo/app" }],
      acquireBundle,
      openTurn,
    })
    const dispatch = { taskId: "build", teammateId: "alice", repositoryId: "app" }

    await expect(controller.openDispatch(dispatch)).rejects.toThrow(/host unavailable/)
    await expect(controller.openDispatch(dispatch)).resolves.toMatchObject({
      bundleId: "bundle-recovered",
    })
    expect(acquireBundle).toHaveBeenCalledTimes(2)
  })

  it("fails closed when the host returns no Bundle Turn lease", async () => {
    const controller = new AgentTeamRegistryWorkspaceController({
      runId: "run-1",
      base: { kind: "localHead" },
      roots: [{ logicalRootId: "app", sourceRoot: "/repo/app" }],
      acquireBundle: jest.fn(async () => bundle("bundle-empty", "app")),
      openTurn: jest.fn(async () => null),
    })

    await expect(
      controller.openDispatch({ taskId: "build", teammateId: "alice", repositoryId: "app" })
    ).rejects.toThrow(/did not return a Bundle Turn execution root/)
  })

  it("aborts a malformed Turn that omits the primary workspace", async () => {
    const abort = jest.fn(async () => [])
    const controller = new AgentTeamRegistryWorkspaceController({
      runId: "run-1",
      base: { kind: "localHead" },
      roots: [{ logicalRootId: "app", sourceRoot: "/repo/app" }],
      acquireBundle: jest.fn(async () => bundle("bundle-malformed", "app")),
      openTurn: jest.fn(async () => ({
        ...turnLease("bundle-malformed", "app"),
        run: turnLease("bundle-malformed", "app").runs[0].run,
        runs: [],
        settle: jest.fn(async () => []),
        abort,
      })),
    })

    await expect(
      controller.openDispatch({ taskId: "build", teammateId: "alice", repositoryId: "app" })
    ).rejects.toThrow(/omitted the primary/)
    expect(abort).toHaveBeenCalled()
  })

  it("promotes manual candidates through the Registry branch command", async () => {
    const createBranch = jest.fn(async (workspaceId: string, branch: string) =>
      managedRecord(workspaceId, branch)
    )
    const controller = new AgentTeamRegistryWorkspaceController({
      runId: "run-1",
      base: { kind: "localHead" },
      roots: [{ logicalRootId: "app", sourceRoot: "/repo/app" }],
      acquireBundle: jest.fn(async () => bundle("bundle-promote", "app")),
      openTurn: jest.fn(async (workspaceBundle, rootId) => ({
        ...turnLease(workspaceBundle.bundleId, rootId),
        run: turnLease(workspaceBundle.bundleId, rootId).runs[0].run,
        settle: jest.fn(async () => []),
        abort: jest.fn(async () => []),
      })),
      createBranch,
    })
    const lease = await controller.openDispatch({
      taskId: "build docs",
      teammateId: "alice",
      teammateName: "Alice Dev",
      repositoryId: "app",
    })
    controller.recordDispatchResult(lease.bundleTurnId, { ok: true, output: "done" })
    expect(controller.getDispatchExecutionRoot("build docs")).toBe("/managed/bundle-promote/app")
    expect(controller.getDispatchExecutionRoot("missing")).toBeUndefined()

    const result = await controller.reconcile({ mode: "manual" })

    expect(createBranch).toHaveBeenCalledWith("workspace-app", "agent/run-1/Alice-Dev/build-docs")
    expect(result).toMatchObject({
      mode: "manual",
      branches: ["agent/run-1/Alice-Dev/build-docs"],
    })
  })

  it("promotes every unique physical workspace in a multi-root Bundle Turn", async () => {
    const createBranch = jest.fn(async (workspaceId: string, branch: string) =>
      managedRecord(workspaceId, branch)
    )
    const controller = new AgentTeamRegistryWorkspaceController({
      runId: "run-1",
      base: { kind: "localHead" },
      roots: [
        { logicalRootId: "app", sourceRoot: "/repo/app" },
        { logicalRootId: "docs", sourceRoot: "/repo/docs" },
      ],
      acquireBundle: jest.fn(async () => bundle("bundle-multi", "app")),
      openTurn: jest.fn(async (workspaceBundle, rootId) => {
        const lease = turnLease(workspaceBundle.bundleId, rootId)
        const additional = {
          ...lease.runs[0],
          workspaceId: "workspace-docs",
          logicalRootIds: ["docs"],
          run: {
            ...lease.runs[0].run,
            runId: "task-run-docs",
            workspaceId: "workspace-docs",
            executionRoot: "/managed/bundle-multi/docs",
          },
        }
        return {
          ...lease,
          additionalAliases: ["/managed/bundle-multi/docs"],
          runs: [...lease.runs, additional],
          run: lease.runs[0].run,
          settle: jest.fn(async () => []),
          abort: jest.fn(async () => []),
        }
      }),
      createBranch,
    })

    const lease = await controller.openDispatch({
      taskId: "build",
      teammateId: "alice",
      repositoryId: "app",
    })
    controller.recordDispatchResult(lease.bundleTurnId, { ok: true })
    const result = await controller.reconcile({ mode: "manual" })

    expect(createBranch).toHaveBeenCalledTimes(2)
    expect(createBranch).toHaveBeenCalledWith("workspace-app", "agent/run-1/alice/build")
    expect(createBranch).toHaveBeenCalledWith("workspace-docs", "agent/run-1/alice/build")
    expect(result.handles.map((handle) => handle.logicalRootId)).toEqual(["app", "docs"])
  })

  it("select promotes only the first successful Registry candidate", async () => {
    let sequence = 0
    const createBranch = jest.fn(async (workspaceId: string, branch: string) =>
      managedRecord(workspaceId, branch)
    )
    const controller = new AgentTeamRegistryWorkspaceController({
      runId: "run-1",
      base: { kind: "localHead" },
      roots: [{ logicalRootId: "app", sourceRoot: "/repo/app" }],
      acquireBundle: jest.fn(async () => bundle(`bundle-${++sequence}`, "app")),
      openTurn: jest.fn(async (workspaceBundle, rootId) => ({
        ...turnLease(workspaceBundle.bundleId, rootId),
        run: turnLease(workspaceBundle.bundleId, rootId).runs[0].run,
        settle: jest.fn(async () => []),
        abort: jest.fn(async () => []),
      })),
      createBranch,
    })
    const failed = await controller.openDispatch({
      taskId: "first",
      teammateId: "alice",
      repositoryId: "app",
    })
    const succeeded = await controller.openDispatch({
      taskId: "second",
      teammateId: "bob",
      repositoryId: "app",
    })
    controller.recordDispatchResult(failed.bundleTurnId, { ok: false })
    controller.recordDispatchResult(succeeded.bundleTurnId, { ok: true })

    const result = await controller.reconcile({
      mode: "select",
      selectStrategy: "first-success",
    })

    expect(createBranch).toHaveBeenCalledTimes(1)
    expect(result.winnerKey).toBe("app:second")
  })

  it("select delegates a choice among successful candidates to the judge", async () => {
    let sequence = 0
    const controller = new AgentTeamRegistryWorkspaceController({
      runId: "run-1",
      base: { kind: "localHead" },
      roots: [{ logicalRootId: "app", sourceRoot: "/repo/app" }],
      acquireBundle: jest.fn(async () => bundle(`bundle-judge-${++sequence}`, "app")),
      openTurn: jest.fn(async (workspaceBundle, rootId) => {
        const lease = turnLease(workspaceBundle.bundleId, rootId)
        lease.runs[0].workspaceId = `workspace-${workspaceBundle.bundleId}`
        return {
          ...lease,
          run: lease.runs[0].run,
          settle: jest.fn(async () => []),
          abort: jest.fn(async () => []),
        }
      }),
      createBranch: jest.fn(async (workspaceId: string, branch: string) =>
        managedRecord(workspaceId, branch)
      ),
    })
    const first = await controller.openDispatch({
      taskId: "first",
      teammateId: "alice",
      repositoryId: "app",
    })
    const second = await controller.openDispatch({
      taskId: "second",
      teammateId: "bob",
      repositoryId: "app",
    })
    controller.recordDispatchResult(first.bundleTurnId, { ok: true, output: "one" })
    controller.recordDispatchResult(second.bundleTurnId, { ok: true, output: "two" })
    const judge = jest.fn(async (candidates) => candidates[1].key)

    const result = await controller.reconcile({ mode: "select", selectStrategy: "judge", judge })

    expect(judge).toHaveBeenCalledWith([
      expect.objectContaining({ key: "app:first", ok: true, output: "one" }),
      expect.objectContaining({ key: "app:second", ok: true, output: "two" }),
    ])
    expect(result.winnerKey).toBe("app:second")
  })

  it("rejects client-side merge-all promotion", async () => {
    const controller = new AgentTeamRegistryWorkspaceController({
      runId: "run-1",
      base: { kind: "localHead" },
      roots: [{ logicalRootId: "app", sourceRoot: "/repo/app" }],
    })

    await expect(controller.reconcile({ mode: "merge-all" })).rejects.toThrow(
      /host-side atomic Registry promotion transaction/
    )
  })
})
