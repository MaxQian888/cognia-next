import type { SessionExecutionContext } from "@/types/execution-context"
import type { DockerSandboxConfig } from "@/types/sandbox"

import {
  LOCAL_FILESPACE_HOST_ID,
  resolveConversationFileSpace,
  type FileSpaceHostState,
  type ResolveConversationFileSpaceInput,
} from "./resolve"

const LOCAL: FileSpaceHostState = { id: LOCAL_FILESPACE_HOST_ID, fsBackend: true, reachable: true }

const PROJECT = {
  id: "p1",
  roots: [
    { id: "root-main", path: "/repo", label: "app", isPrimary: true },
    { id: "root-docs", path: "/docs" },
  ],
}

function input(
  overrides: Partial<ResolveConversationFileSpaceInput> = {}
): ResolveConversationFileSpaceInput {
  return {
    sessionId: "s1",
    session: { projectId: "p1" },
    project: PROJECT,
    hasUploads: false,
    hasArtifacts: false,
    host: LOCAL,
    ...overrides,
  }
}

function context(overrides: Partial<SessionExecutionContext>): SessionExecutionContext {
  return {
    location: "managedWorktree",
    projectId: "p1",
    projectRoot: "/repo",
    taskWorkspace: { taskId: "task-workspace:s1", workspaceKey: "s1" },
    ...overrides,
  }
}

describe("resolveConversationFileSpace", () => {
  it("projects a conversation with no execution binding onto its workspace roots", () => {
    const space = resolveConversationFileSpace(input())
    expect(space).toMatchObject({ sessionId: "s1", status: "available", hostId: "local" })
    expect(space.mounts).toEqual([
      {
        id: "workspace",
        virtualPath: "/workspace",
        backing: "disk",
        label: "app",
        hostPath: "/repo",
        managed: false,
        role: "primary",
        logicalRootId: "root-main",
        writable: true,
        status: "available",
      },
      {
        id: "root:root-docs",
        virtualPath: "/roots/root-docs",
        backing: "disk",
        label: "docs",
        hostPath: "/docs",
        managed: false,
        role: "additional",
        logicalRootId: "root-docs",
        writable: true,
        status: "available",
      },
    ])
  })

  it("puts /workspace on the worktree a conversation runs in, flagged managed", () => {
    const space = resolveConversationFileSpace(
      input({
        session: {
          projectId: "p1",
          executionContext: context({
            execution: {
              mode: "managed",
              base: { kind: "workingState" },
              roots: [
                { logicalRootId: "root-main", role: "primary", aliasPath: "/wt/s1/app" },
                { logicalRootId: "root-docs", role: "additional", aliasPath: "/wt/s1/docs" },
              ],
            },
          }),
        },
      })
    )
    expect(space.mounts.map((mount) => [mount.virtualPath, mount.hostPath, mount.managed])).toEqual(
      [
        ["/workspace", "/wt/s1/app", true],
        ["/roots/root-docs", "/wt/s1/docs", true],
      ]
    )
    // The checkout the worktree was cut from is deliberately not listed.
    expect(space.mounts.some((mount) => mount.hostPath === "/repo")).toBe(false)
  })

  it("does not flag a local-mode lease on the checkout itself as managed", () => {
    const space = resolveConversationFileSpace(
      input({
        session: {
          projectId: "p1",
          executionContext: context({
            location: "local",
            execution: {
              mode: "local",
              base: { kind: "workingState" },
              roots: [{ logicalRootId: "primary", role: "primary", aliasPath: "/repo" }],
            },
          }),
        },
      })
    )
    const workspace = space.mounts.find((mount) => mount.id === "workspace")
    expect(workspace).toMatchObject({ hostPath: "/repo", managed: false, label: "app" })
    // The primary root is not listed twice under its workspace id.
    expect(space.mounts.filter((mount) => mount.hostPath === "/repo")).toHaveLength(1)
    // The uncovered additional root is still part of what the agent can reach.
    expect(space.mounts.map((mount) => mount.id)).toEqual(["workspace", "root:root-docs"])
  })

  it("lists a managed workspace that is not on this device with its reason", () => {
    const space = resolveConversationFileSpace(
      input({
        project: null,
        session: {
          executionContext: context({
            workspaceBinding: { kind: "managed", workspaceId: "managed-workspace:s1" },
            managedWorkspace: { availability: "missing-on-device" },
            execution: {
              mode: "managed",
              base: { kind: "workingState" },
              roots: [{ logicalRootId: "primary", role: "primary", aliasPath: "/other/device" }],
            },
          }),
        },
      })
    )
    expect(space.status).toBe("offline")
    expect(space.mounts).toEqual([
      expect.objectContaining({
        id: "workspace",
        managed: true,
        writable: false,
        status: "missing",
        statusReason: "managed-missing-on-device",
      }),
    ])
    expect(space.mounts[0]).not.toHaveProperty("hostPath")
  })

  it("marks a deleted managed workspace deleted", () => {
    const space = resolveConversationFileSpace(
      input({
        project: null,
        session: {
          executionContext: context({
            workspaceBinding: { kind: "managed", workspaceId: "m" },
            managedWorkspace: { availability: "deleted", deletedRoot: "/trash/m" },
          }),
        },
      })
    )
    expect(space.mounts[0]).toMatchObject({ status: "deleted", statusReason: "managed-deleted" })
  })

  it("treats an available managed workspace as managed", () => {
    const space = resolveConversationFileSpace(
      input({
        project: null,
        session: {
          executionContext: context({
            workspaceBinding: { kind: "managed", workspaceId: "m" },
            managedWorkspace: { availability: "available", localRoot: "/data/managed/m" },
            projectRoot: "",
            execution: { mode: "managed", base: { kind: "workingState" }, roots: [] },
          }),
        },
      })
    )
    expect(space.mounts).toEqual([
      expect.objectContaining({ hostPath: "/data/managed/m", managed: true, label: "m" }),
    ])
  })

  it("reports why disk mounts are unreachable from here", () => {
    const web = resolveConversationFileSpace(
      input({ host: { id: "local", fsBackend: false, reachable: true } })
    )
    expect(web.status).toBe("offline")
    expect(web.mounts.every((mount) => mount.statusReason === "no-fs-backend")).toBe(true)
    expect(web.mounts.every((mount) => !mount.writable)).toBe(true)

    const remote = resolveConversationFileSpace(
      input({ host: { id: "h1", label: "build box", fsBackend: true, reachable: false } })
    )
    expect(remote).toMatchObject({ hostId: "h1", hostLabel: "build box", status: "offline" })
    expect(remote.mounts[0]).toMatchObject({ status: "offline", statusReason: "host-offline" })
  })

  it("adds read-only Dexie mounts that stay available without a filesystem", () => {
    const space = resolveConversationFileSpace(
      input({
        project: null,
        hasUploads: true,
        hasArtifacts: true,
        host: { id: "local", fsBackend: false, reachable: true },
      })
    )
    expect(space.status).toBe("available")
    expect(space.mounts.map((mount) => [mount.id, mount.backing, mount.writable])).toEqual([
      ["uploads", "dexie", false],
      ["artifacts", "dexie", false],
    ])
  })

  it("maps disk mounts into a bound Docker sandbox", () => {
    const docker: DockerSandboxConfig = {
      image: "node:22",
      workspaceMount: { hostPath: "/repo", containerPath: "/workspace" },
    } as DockerSandboxConfig
    const space = resolveConversationFileSpace(input({ dockerSandbox: docker }))
    expect(space.mounts.find((mount) => mount.id === "workspace")?.containerPath).toBe("/workspace")
    // A root outside the mapped directory has no path inside the container.
    expect(space.mounts.find((mount) => mount.id === "root:root-docs")).not.toHaveProperty(
      "containerPath"
    )
  })

  it("encodes a root id that would break the path grammar", () => {
    const space = resolveConversationFileSpace(
      input({
        project: {
          id: "p1",
          roots: [
            { id: "root-main", path: "/repo", isPrimary: true },
            { id: "a/b", path: "/x" },
            { id: "..", path: "/y" },
          ],
        },
      })
    )
    expect(space.mounts.map((mount) => mount.virtualPath)).toEqual([
      "/workspace",
      "/roots/a%2Fb",
      "/roots/%2E%2E",
    ])
  })

  it("is deleted, with no mounts, when the session does not exist", () => {
    expect(resolveConversationFileSpace(input({ session: null }))).toEqual({
      sessionId: "s1",
      hostId: "local",
      status: "deleted",
      mounts: [],
    })
  })

  it("is offline with no mounts for a conversation with nothing yet", () => {
    expect(resolveConversationFileSpace(input({ project: null, session: {} }))).toMatchObject({
      status: "offline",
      mounts: [],
    })
  })
})
