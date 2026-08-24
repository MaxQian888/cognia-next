const beginBundleTurn = jest.fn()
const settleBundleTurn = jest.fn()
const abortBundleTurn = jest.fn()

jest.mock("./client", () => ({
  beginWorkspaceBundleTurn: (...args: unknown[]) => beginBundleTurn(...args),
  settleWorkspaceBundleTurn: (...args: unknown[]) => settleBundleTurn(...args),
  abortWorkspaceBundleTurn: (...args: unknown[]) => abortBundleTurn(...args),
}))

import { openWorkspaceBundleTurnLease } from "./run-lease"

describe("openWorkspaceBundleTurnLease", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    beginBundleTurn.mockResolvedValue(null)
    settleBundleTurn.mockResolvedValue({ resources: [] })
    abortBundleTurn.mockResolvedValue({ resources: [] })
  })

  it("leases every physical workspace in a bundle and preserves its logical aliases", async () => {
    beginBundleTurn.mockResolvedValue({
      bundleTurnId: "bundle-turn-1",
      bundleId: "bundle-1",
      primaryLogicalRootId: "app",
      primaryAlias: "/aliases/app",
      additionalAliases: ["/aliases/app-tests", "/aliases/docs"],
      runs: [
        {
          workspaceId: "workspace-app",
          logicalRootIds: ["app", "app-tests"],
          run: { runId: "turn-1", executionRoot: "/physical/app" },
        },
        {
          workspaceId: "workspace-docs",
          logicalRootIds: ["docs"],
          run: { runId: "turn-1:docs", executionRoot: "/physical/docs" },
        },
      ],
    })
    settleBundleTurn.mockResolvedValue({
      resources: [
        { runId: "turn-1", path: "src/a.ts" },
        { runId: "turn-1:docs", path: "guide.md" },
      ],
    })
    const input = {
      taskId: "task-1",
      sessionId: "session-1",
      runId: "turn-1",
      agentId: "built-in",
      agentKind: "in-app",
      workspaceRoot: "/aliases/app",
    }

    const lease = await openWorkspaceBundleTurnLease(
      {
        bundleId: "bundle-1",
        leases: [
          {
            bundleId: "bundle-1",
            workspaceId: "workspace-app",
            logicalRootId: "app",
            role: "primary",
            aliasPath: "/aliases/app",
          },
          {
            bundleId: "bundle-1",
            workspaceId: "workspace-app",
            logicalRootId: "app-tests",
            role: "additional",
            aliasPath: "/aliases/app-tests",
          },
          {
            bundleId: "bundle-1",
            workspaceId: "workspace-docs",
            logicalRootId: "docs",
            role: "additional",
            aliasPath: "/aliases/docs",
          },
        ],
      },
      "app",
      input
    )

    expect(beginBundleTurn).toHaveBeenCalledTimes(1)
    expect(beginBundleTurn).toHaveBeenCalledWith("bundle-1", {
      primaryLogicalRootId: "app",
      run: input,
    })
    expect(lease).toMatchObject({
      bundleId: "bundle-1",
      primaryAlias: "/aliases/app",
      additionalAliases: ["/aliases/app-tests", "/aliases/docs"],
    })
    expect(lease?.runs).toHaveLength(2)

    await lease?.settle("ready")
    expect(settleBundleTurn).toHaveBeenCalledWith("bundle-turn-1", "ready")
  })

  it("fails closed when the host cannot open the complete persisted bundle turn", async () => {
    beginBundleTurn.mockResolvedValueOnce(null)

    const lease = await openWorkspaceBundleTurnLease(
      {
        bundleId: "bundle-1",
        leases: [
          {
            bundleId: "bundle-1",
            workspaceId: "workspace-app",
            logicalRootId: "app",
            role: "primary",
            aliasPath: "/aliases/app",
          },
          {
            bundleId: "bundle-1",
            workspaceId: "workspace-docs",
            logicalRootId: "docs",
            role: "additional",
            aliasPath: "/aliases/docs",
          },
        ],
      },
      "app",
      {
        taskId: "task-1",
        sessionId: "session-1",
        runId: "turn-1",
        agentId: "built-in",
        agentKind: "in-app",
        workspaceRoot: "/aliases/app",
      }
    )

    expect(lease).toBeNull()
    expect(settleBundleTurn).not.toHaveBeenCalled()
  })

  it("aborts the complete persisted bundle turn", async () => {
    beginBundleTurn.mockResolvedValueOnce({
      bundleTurnId: "bundle-turn-1",
      bundleId: "bundle-1",
      primaryLogicalRootId: "app",
      primaryAlias: "/aliases/app",
      additionalAliases: [],
      runs: [
        {
          workspaceId: "workspace-app",
          logicalRootIds: ["app"],
          run: { runId: "turn-1", executionRoot: "/physical/app" },
        },
      ],
    })

    const lease = await openWorkspaceBundleTurnLease({ bundleId: "bundle-1", leases: [] }, "app", {
      taskId: "task-1",
      sessionId: "session-1",
      runId: "turn-1",
      agentId: "built-in",
      agentKind: "in-app",
      workspaceRoot: "/aliases/app",
    })

    await lease?.abort()
    expect(abortBundleTurn).toHaveBeenCalledWith("bundle-turn-1")
  })
})
