import type { ChatSession } from "@cognia/agent-config-types"
jest.mock("./client", () => ({
  ensureSessionScratchWorkspaceBundle: jest.fn(),
  archiveManagedWorkspace: jest.fn(),
  getWorkspaceBundle: jest.fn(),
  listWorkspaceBundles: jest.fn(),
  getManagedWorkspace: jest.fn(),
}))
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  getRuntimeSnapshot: jest.fn(() => ({ target: null })),
}))
jest.mock("./user-action", () => ({
  runWorkspaceUserAction: jest.fn((_command, action) => action()),
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn(), updateSession: jest.fn() }))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isHeadlessHost: jest.fn(() => false),
}))
import {
  archiveSessionScratchWorkspace,
  createManagedWorkspaceArchive,
  createManagedWorkspaceContext,
  ensureSessionScratchWorkspace,
  isSessionScratchWorkspace,
  mergePortableManagedContext,
  convertManagedWorkspaceToProject,
  deleteManagedWorkspace,
  importManagedWorkspaceArchive,
  materializeManagedWorkspace,
  portableExecutionContext,
  rebindManagedWorkspace,
  restoreManagedWorkspace,
} from "./managed-workspace"
import type { SessionScratchWorkspaceDeps } from "./managed-workspace"
import type { WorkspaceBundle } from "./types"
import {
  archiveManagedWorkspace,
  ensureSessionScratchWorkspaceBundle,
  getWorkspaceBundle,
  listWorkspaceBundles,
  getManagedWorkspace,
} from "./client"
import { getSession } from "@/lib/db/sessions"
import { isHeadlessHost } from "@/lib/platform/detect"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { sha256Hex } from "@/lib/share/hash"
import { runWorkspaceUserAction } from "./user-action"

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    title: "Task",
    createdAt: 0,
    updatedAt: 0,
    executionContext: createManagedWorkspaceContext("session-1", 10),
    ...overrides,
  }
}

function fixture() {
  let row = session()
  const directories = new Set<string>(["/data"])
  const files = new Map<string, Uint8Array>()
  const updates: unknown[] = []
  const deps = {
    now: () => 20,
    managedBaseRoot: async () => "/data/managed-workspaces",
    getSession: async () => row,
    updateSession: async (_id: string, patch: Partial<ChatSession>) => {
      updates.push(patch)
      row = { ...row, ...patch }
    },
    exists: async (path: string) => directories.has(path) || files.has(path),
    mkdir: async (path: string) => void directories.add(path),
    rename: async (from: string, to: string) => {
      if (!directories.delete(from)) throw new Error("missing source")
      directories.add(to)
      for (const [path, bytes] of [...files]) {
        if (!path.startsWith(`${from}/`)) continue
        files.delete(path)
        files.set(`${to}${path.slice(from.length)}`, bytes)
      }
    },
    readDir: async (path: string) => {
      const prefix = `${path}/`
      const names = new Map<string, { name: string; isDirectory: boolean; isFile: boolean }>()
      for (const directory of directories) {
        if (!directory.startsWith(prefix)) continue
        const rest = directory.slice(prefix.length)
        if (rest && !rest.includes("/")) {
          names.set(rest, { name: rest, isDirectory: true, isFile: false })
        }
      }
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue
        const rest = file.slice(prefix.length)
        if (rest && !rest.includes("/")) {
          names.set(rest, { name: rest, isDirectory: false, isFile: true })
        }
      }
      return [...names.values()]
    },
    readFile: async (path: string) => files.get(path)!,
    writeFile: async (path: string, bytes: Uint8Array) => void files.set(path, bytes),
    registerAllowedRoot: async () => undefined,
    createProject: (rootDir: string) => ({ id: "project-new", rootDir }),
    addSessionToProject: jest.fn(),
  }
  return {
    deps,
    directories,
    files,
    updates,
    get row() {
      return row
    },
  }
}

describe("managed workspace lifecycle", () => {
  it("creates a stable projectless binding and materializes it on this device", async () => {
    const fx = fixture()
    const context = await materializeManagedWorkspace("session-1", fx.deps)

    expect(context.workspaceBinding).toEqual({
      kind: "managed",
      workspaceId: "managed-workspace:session-1",
    })
    expect(context.managedWorkspace).toEqual(
      expect.objectContaining({
        availability: "available",
        localRoot: "/data/managed-workspaces/managed-workspace_session-1",
      })
    )
    expect(context.projectRoot).toBe(context.managedWorkspace?.localRoot)
    expect(fx.directories).toContain(context.projectRoot)
  })

  it("strips device paths from portable sync and marks the receiver missing", () => {
    const local = createManagedWorkspaceContext("session-1", 10, "/private/root")
    const portable = portableExecutionContext(local)

    expect(portable.projectRoot).toBe("")
    expect(portable.worktreePath).toBeUndefined()
    expect(portable.managedWorkspace).toEqual({ availability: "missing-on-device" })
    expect(portable.workspaceBinding).toEqual(local.workspaceBinding)
  })

  it("requires an explicit existing directory when rebinding", async () => {
    const fx = fixture()
    await expect(rebindManagedWorkspace("session-1", "/missing", fx.deps)).rejects.toThrow(
      /does not exist/
    )
    fx.directories.add("/imported")
    const context = await rebindManagedWorkspace("session-1", "/imported", fx.deps)
    expect(context.managedWorkspace).toEqual(
      expect.objectContaining({ availability: "available", localRoot: "/imported", reboundAt: 20 })
    )
  })

  it("deletes recoverably and restores the same workspace identity", async () => {
    const fx = fixture()
    await materializeManagedWorkspace("session-1", fx.deps)
    const deleted = await deleteManagedWorkspace("session-1", fx.deps)
    expect(deleted.managedWorkspace).toEqual(
      expect.objectContaining({ availability: "deleted", deletedAt: 20 })
    )
    expect(deleted.workspaceBinding).toEqual({
      kind: "managed",
      workspaceId: "managed-workspace:session-1",
    })
    const restored = await restoreManagedWorkspace("session-1", fx.deps)
    expect(restored.managedWorkspace).toEqual(
      expect.objectContaining({ availability: "available" })
    )
  })

  it("round-trips nested files through a bounded portable archive", async () => {
    const fx = fixture()
    const context = await materializeManagedWorkspace("session-1", fx.deps)
    const root = context.projectRoot
    fx.directories.add(`${root}/src`)
    fx.files.set(`${root}/README.md`, new TextEncoder().encode("hello"))
    fx.files.set(`${root}/src/index.ts`, new TextEncoder().encode("export {}"))

    const archive = await createManagedWorkspaceArchive("session-1", fx.deps)
    expect(archive.files.map((file) => file.path)).toEqual(["README.md", "src/index.ts"])

    fx.directories.add("/restored")
    await importManagedWorkspaceArchive("session-1", archive, "/restored", fx.deps)
    expect(new TextDecoder().decode(fx.files.get("/restored/README.md"))).toBe("hello")
    expect(new TextDecoder().decode(fx.files.get("/restored/src/index.ts"))).toBe("export {}")
    expect(fx.row.executionContext?.managedWorkspace?.localRoot).toBe("/restored")
  })

  it("registers an available managed root as a Project without moving files", async () => {
    const fx = fixture()
    await materializeManagedWorkspace("session-1", fx.deps)
    const result = await convertManagedWorkspaceToProject("session-1", "Task workspace", fx.deps)

    expect(result.projectId).toBe("project-new")
    expect(result.context).toEqual(
      expect.objectContaining({
        location: "local",
        workspaceBinding: { kind: "project", projectId: "project-new" },
        projectId: "project-new",
      })
    )
    expect(fx.deps.addSessionToProject).toHaveBeenCalledWith("project-new", "session-1")
    expect(fx.row.projectId).toBe("project-new")
  })

  it("rejects traversal and oversized archives before writing", async () => {
    const fx = fixture()
    fx.directories.add("/target")
    await expect(
      importManagedWorkspaceArchive(
        "session-1",
        {
          version: 1,
          workspaceId: "managed-workspace:session-1",
          exportedAt: 20,
          files: [{ path: "../escape", dataBase64: "eA==", size: 1 }],
        },
        "/target",
        fx.deps
      )
    ).rejects.toThrow(/unsafe path/)
  })
})

describe("headless session scratch workspace", () => {
  beforeEach(() => {
    jest.mocked(isHeadlessHost).mockReturnValue(false)
    jest.mocked(getSession).mockReset()
    jest.mocked(ensureSessionScratchWorkspaceBundle).mockReset()
    jest.mocked(archiveManagedWorkspace).mockReset()
    jest.mocked(getWorkspaceBundle).mockReset()
    jest.mocked(listWorkspaceBundles).mockReset()
    jest.mocked(getManagedWorkspace).mockReset()
    jest
      .mocked(getRuntimeSnapshot)
      .mockReturnValue({ target: null, vaultState: "unavailable", connectionState: "offline" })
  })
  function scratchFixture() {
    let row = session({
      executionContext: undefined,
      platformBinding: {
        platform: "telegram",
        adapterId: "adapter",
        conversationKey: "thread",
        conversationRef: { platform: "telegram", adapterId: "adapter" },
      },
    })
    const bundle: WorkspaceBundle = {
      bundleId: "scratch-bundle",
      ownerType: "session",
      ownerRef: row.id,
      environmentKind: "managed",
      state: "active",
      leases: [
        {
          bundleId: "scratch-bundle",
          workspaceId: "scratch-workspace",
          logicalRootId: "primary",
          role: "primary",
          aliasPath: "/host/managed/opaque-id",
        },
      ],
      lastUsedAt: 10,
      createdAt: 10,
      pinned: false,
    }
    const ensureBundle = jest.fn(async () => bundle)
    const write = jest.fn(async (_id: string, patch: Partial<ChatSession>) => {
      row = { ...row, ...patch }
    })
    const deps: SessionScratchWorkspaceDeps = {
      isHeadlessHost: () => true,
      now: () => 20,
      getSession: async () => row,
      updateSession: write,
      ensureBundle,
    }
    return {
      deps,
      bundle,
      ensureBundle,
      write,
      get row() {
        return row
      },
    }
  }

  it("coalesces concurrent upgrades and reuses the durable bundle on later calls", async () => {
    const fx = scratchFixture()
    expect(
      await Promise.all([
        ensureSessionScratchWorkspace(fx.row, fx.deps),
        ensureSessionScratchWorkspace(fx.row, fx.deps),
      ])
    ).toEqual(["/host/managed/opaque-id", "/host/managed/opaque-id"])
    expect(fx.ensureBundle).toHaveBeenCalledTimes(1)
    expect(fx.row.projectId).toBe("project-default")
    expect(fx.row.workingDir).toBeUndefined()
    expect(isSessionScratchWorkspace(fx.row)).toBe(true)
    expect(fx.row.executionContext?.execution).toEqual({
      mode: "managed",
      base: { kind: "workingState" },
      bundleId: "scratch-bundle",
      roots: [
        {
          logicalRootId: "primary",
          role: "primary",
          aliasPath: "/host/managed/opaque-id",
          workspaceId: "scratch-workspace",
        },
      ],
    })
    await ensureSessionScratchWorkspace(fx.row, { ...fx.deps })
    expect(fx.ensureBundle).toHaveBeenLastCalledWith("session-1", "scratch-bundle")
  })

  it("propagates persistence failure and recovers the same owner on retry", async () => {
    const fx = scratchFixture()
    fx.write.mockRejectedValueOnce(new Error("Dexie write failed"))
    await expect(ensureSessionScratchWorkspace(fx.row, fx.deps)).rejects.toThrow(
      "Dexie write failed"
    )
    expect(fx.row.executionContext).toBeUndefined()
    await expect(ensureSessionScratchWorkspace(fx.row, fx.deps)).resolves.toBe(
      "/host/managed/opaque-id"
    )
    expect(fx.ensureBundle.mock.calls).toEqual([
      ["session-1", undefined],
      ["session-1", undefined],
    ])
    expect(fx.row.executionContext?.execution?.bundleId).toBe("scratch-bundle")
  })

  it("refuses foreign bundles without writing the session", async () => {
    const fx = scratchFixture()
    fx.bundle.ownerRef = "other-session"
    await expect(ensureSessionScratchWorkspace(fx.row, fx.deps)).rejects.toThrow("another session")
    expect(fx.write).not.toHaveBeenCalled()
  })

  it("does not create a workspace for an already deleted session", async () => {
    const fx = scratchFixture()
    await expect(
      ensureSessionScratchWorkspace(fx.row, {
        ...fx.deps,
        getSession: async () => undefined,
      })
    ).rejects.toThrow("no longer exists")
    expect(fx.ensureBundle).not.toHaveBeenCalled()
    expect(fx.write).not.toHaveBeenCalled()
  })

  it.each(["deleted", "project-bound"])(
    "does not overwrite a session that becomes %s during provisioning",
    async (state) => {
      const fx = scratchFixture()
      const read = jest
        .fn()
        .mockResolvedValueOnce(fx.row)
        .mockResolvedValueOnce(
          state === "deleted" ? undefined : { ...fx.row, projectId: "project-new" }
        )
      await expect(
        ensureSessionScratchWorkspace(fx.row, {
          ...fx.deps,
          getSession: read,
        })
      ).rejects.toThrow(state === "deleted" ? "no longer exists" : "Project-bound")
      expect(fx.ensureBundle).toHaveBeenCalledTimes(1)
      expect(fx.write).not.toHaveBeenCalled()
    }
  )

  it("never provisions on desktop or replaces a project-bound session", async () => {
    const fx = scratchFixture()
    await expect(
      ensureSessionScratchWorkspace(fx.row, { ...fx.deps, isHeadlessHost: () => false })
    ).rejects.toThrow("headless host")
    const projectSession = { ...fx.row, projectId: "project-missing" }
    await expect(
      ensureSessionScratchWorkspace(projectSession, {
        ...fx.deps,
        getSession: async () => projectSession,
      })
    ).rejects.toThrow("Project-bound")
    expect(fx.ensureBundle).not.toHaveBeenCalled()
    expect(isSessionScratchWorkspace(undefined)).toBe(false)
    expect(isSessionScratchWorkspace(null)).toBe(false)
  })

  it("strips host bundle, aliases, environment and run leases while retaining portable identity", async () => {
    const fx = scratchFixture()
    await ensureSessionScratchWorkspace(fx.row, fx.deps)
    const local = fx.row.executionContext!
    local.environmentId = "host-environment"
    local.execution!.environmentId = "host-environment"
    local.taskWorkspace.runId = "host-run"
    local.taskWorkspace.bundleTurnId = "host-turn"
    const portable = portableExecutionContext(local)
    expect(JSON.stringify(portable)).not.toMatch(
      /host\/managed|scratch-bundle|scratch-workspace|host-environment|host-run|host-turn/
    )
    expect(portable.execution).toEqual({
      mode: "managed",
      base: { kind: "workingState" },
      roots: [],
    })
    expect(isSessionScratchWorkspace({ ...fx.row, executionContext: portable })).toBe(true)
    expect(mergePortableManagedContext(local)).toEqual(portable)
    expect(mergePortableManagedContext(portable, local).execution).toEqual(local.execution)
    expect(mergePortableManagedContext(portable, local).taskWorkspace).toEqual(local.taskWorkspace)
  })

  it("archives only the revalidated service-owned scratch workspace on the host", async () => {
    const fx = scratchFixture()
    await ensureSessionScratchWorkspace(fx.row, fx.deps)
    jest.mocked(getSession).mockResolvedValue(fx.row)
    jest.mocked(getWorkspaceBundle).mockResolvedValue(fx.bundle)
    jest.mocked(getManagedWorkspace).mockResolvedValue({
      ownerType: "session",
      ownerRef: fx.row.id,
      environmentKind: "managed",
      isolationKind: "shadow",
      base: { kind: "workingState" },
      sourceRoot: `/host/sources/session-scratch/${await sha256Hex(fx.row.id)}`,
    } as never)
    await archiveSessionScratchWorkspace(fx.row.id)
    expect(getSession).not.toHaveBeenCalled()
    jest.mocked(isHeadlessHost).mockReturnValue(true)
    await archiveSessionScratchWorkspace(fx.row.id)
    expect(getWorkspaceBundle).toHaveBeenCalledWith("scratch-bundle")
    expect(archiveManagedWorkspace).toHaveBeenCalledWith("scratch-workspace")
    jest.mocked(getSession).mockClear()
    jest.mocked(getSession).mockRejectedValue(new Error("must not reread inside a ledger hold"))
    await archiveSessionScratchWorkspace(fx.row)
    expect(getSession).not.toHaveBeenCalled()
    jest.mocked(archiveManagedWorkspace).mockClear()
    fx.bundle.ownerRef = "sibling"
    await expect(archiveSessionScratchWorkspace(fx.row)).rejects.toThrow("another session")
    expect(archiveManagedWorkspace).not.toHaveBeenCalled()
  })

  it("archives a synced scratch owner through its companion before the host-state write", async () => {
    const fx = scratchFixture()
    await ensureSessionScratchWorkspace(fx.row, fx.deps)
    const synced = {
      ...fx.row,
      executionContext: portableExecutionContext(fx.row.executionContext!),
      platformBinding: {
        platform: "telegram" as const,
        adapterId: "adapter",
        conversationKey: "thread",
        conversationRef: { platform: "telegram" as const, adapterId: "adapter" },
      },
    }
    jest.mocked(getRuntimeSnapshot).mockReturnValue({
      target: { id: "paired", kind: "companion", platform: "mobile", hostKind: "cloud" },
      vaultState: "unlocked",
      connectionState: "online",
    })
    jest.mocked(getSession).mockResolvedValue(synced)
    jest.mocked(listWorkspaceBundles).mockResolvedValue([fx.bundle])
    jest.mocked(getManagedWorkspace).mockResolvedValue({
      ownerType: "session",
      ownerRef: fx.row.id,
      environmentKind: "managed",
      isolationKind: "shadow",
      base: { kind: "workingState" },
      sourceRoot: `/host/sources/session-scratch/${await sha256Hex(fx.row.id)}`,
    } as never)
    await archiveSessionScratchWorkspace(fx.row.id)
    expect(ensureSessionScratchWorkspaceBundle).not.toHaveBeenCalled()
    expect(runWorkspaceUserAction).toHaveBeenCalledWith(
      "task_workspace_managed_archive",
      expect.any(Function)
    )
    expect(archiveManagedWorkspace).toHaveBeenCalledWith("scratch-workspace")
    jest.mocked(archiveManagedWorkspace).mockClear()
    jest.mocked(getManagedWorkspace).mockResolvedValue({
      ownerType: "session",
      ownerRef: fx.row.id,
      environmentKind: "managed",
      isolationKind: "shadow",
      base: { kind: "workingState" },
      sourceRoot: "/desktop/managed-workspaces/managed-workspace_session-1",
    } as never)
    await archiveSessionScratchWorkspace(fx.row.id)
    expect(archiveManagedWorkspace).not.toHaveBeenCalled()
  })
})
