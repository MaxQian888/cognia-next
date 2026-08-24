const acquireWorkspaceBundle = jest.fn()
const getWorkspaceBundle = jest.fn()

jest.mock("./client", () => ({
  acquireWorkspaceBundle: (...args: unknown[]) => acquireWorkspaceBundle(...args),
  getWorkspaceBundle: (...args: unknown[]) => getWorkspaceBundle(...args),
}))

import { ensureSessionExecutionBundle } from "./session-bundle"
import type { SessionExecutionContext } from "@/types/execution-context"

const context: SessionExecutionContext = {
  location: "managedWorktree",
  projectId: "project-1",
  projectRoot: "/repo",
  execution: {
    mode: "managed",
    base: { kind: "remoteDefault" },
    roots: [],
  },
  taskWorkspace: { taskId: "task-1", workspaceKey: "session-1" },
  lifecycle: { state: "requested", createdAt: 1, updatedAt: 1, pinned: false },
}

const project = {
  id: "project-1",
  roots: [
    { id: "app", path: "/repo", isPrimary: true },
    { id: "docs", path: "/docs" },
  ],
}

const bundle = {
  bundleId: "bundle-1",
  environmentKind: "managed" as const,
  ownerType: "session" as const,
  ownerRef: "session-1",
  state: "active" as const,
  leases: [
    {
      bundleId: "bundle-1",
      workspaceId: "workspace-app",
      logicalRootId: "app",
      role: "primary" as const,
      aliasPath: "/isolated/app",
    },
    {
      bundleId: "bundle-1",
      workspaceId: "workspace-docs",
      logicalRootId: "docs",
      role: "additional" as const,
      aliasPath: "/isolated/docs",
    },
  ],
  lastUsedAt: 2,
  pinned: false,
  createdAt: 1,
}

describe("ensureSessionExecutionBundle", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    acquireWorkspaceBundle.mockResolvedValue(bundle)
    getWorkspaceBundle.mockResolvedValue(null)
  })

  it("acquires every Project root and replaces live paths with lease aliases", async () => {
    const binding = await ensureSessionExecutionBundle({
      sessionId: "session-1",
      context: {
        ...context,
        worktreePath: "/legacy/worktree",
        branch: "legacy-branch",
        baseRef: "legacy-base",
      },
      project,
    })

    expect(acquireWorkspaceBundle).toHaveBeenCalledWith({
      ownerType: "session",
      ownerRef: "session-1",
      // Stamped onto every Registry row the bundle provisions, so deleting the
      // workspace can find the directories it produced.
      projectId: project.id,
      environmentKind: "managed",
      base: { kind: "remoteDefault" },
      roots: [
        { logicalRootId: "app", role: "primary", sourceRoot: "/repo" },
        { logicalRootId: "docs", role: "additional", sourceRoot: "/docs" },
      ],
    })
    expect(binding.primaryAlias).toBe("/isolated/app")
    expect(binding.additionalAliases).toEqual(["/isolated/docs"])
    expect(binding.context.execution).toMatchObject({
      bundleId: "bundle-1",
      roots: [
        { logicalRootId: "app", aliasPath: "/isolated/app" },
        { logicalRootId: "docs", aliasPath: "/isolated/docs" },
      ],
    })
    expect(binding.context).not.toHaveProperty("worktreePath")
    expect(binding.context).not.toHaveProperty("branch")
    expect(binding.context).not.toHaveProperty("baseRef")
  })

  it("reuses a persisted active bundle without provisioning again", async () => {
    getWorkspaceBundle.mockResolvedValue(bundle)

    await ensureSessionExecutionBundle({
      sessionId: "session-1",
      context: { ...context, execution: { ...context.execution!, bundleId: "bundle-1" } },
      project,
    })

    expect(acquireWorkspaceBundle).not.toHaveBeenCalled()
  })

  it("fails closed when Project roots changed after acquisition", async () => {
    getWorkspaceBundle.mockResolvedValue({ ...bundle, leases: [bundle.leases[0]] })

    await expect(
      ensureSessionExecutionBundle({
        sessionId: "session-1",
        context: { ...context, execution: { ...context.execution!, bundleId: "bundle-1" } },
        project,
      })
    ).rejects.toThrow("missing Project root: docs")
  })

  it("fails closed when a persisted bundle contains a stale extra Project root", async () => {
    getWorkspaceBundle.mockResolvedValue({
      ...bundle,
      leases: [
        ...bundle.leases,
        {
          bundleId: "bundle-1",
          workspaceId: "workspace-old",
          logicalRootId: "removed-root",
          role: "additional",
          aliasPath: "/isolated/removed",
        },
      ],
    })

    await expect(
      ensureSessionExecutionBundle({
        sessionId: "session-1",
        context: { ...context, execution: { ...context.execution!, bundleId: "bundle-1" } },
        project,
      })
    ).rejects.toThrow("contains stale Project root: removed-root")
  })
})
