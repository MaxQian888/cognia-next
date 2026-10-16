import type { ChatSession } from "@cognia/agent-config-types"
jest.mock("./client", () => ({
  WorkspacePortLeaseError: jest.requireActual("./client").WorkspacePortLeaseError,
  ensureSessionScratchWorkspaceBundle: jest.fn(),
  archiveManagedWorkspace: jest.fn(),
  getWorkspaceBundle: jest.fn(),
  listWorkspaceBundles: jest.fn(),
  getManagedWorkspace: jest.fn(),
  ensureSubjectPortLease: jest.fn(),
  getSubjectPortLeases: jest.fn(),
  releaseSubjectPortLeases: jest.fn(),
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
  ManagedWorkspacePortLeaseCleanupError,
} from "./managed-workspace"
import type { SessionScratchWorkspaceDeps } from "./managed-workspace"
import type { WorkspaceBundle, WorkspacePortLease } from "./types"
import {
  archiveManagedWorkspace,
  ensureSessionScratchWorkspaceBundle,
  getWorkspaceBundle,
  listWorkspaceBundles,
  getManagedWorkspace,
  WorkspacePortLeaseError,
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
  const leases = new Map<string, WorkspacePortLease>()
  const aliases = new Map<string, string>()
  const references = new Map<string, Set<string>>()
  const projects = new Map<string, { id: string; rootDir: string }>()
  type Subject = { kind: "desktop-session" | "project-root"; key: string }
  const subjectId = ({ kind, key }: Subject) => `${kind}:${key}`
  const release = (subject: Subject & { leaseId?: string }) => {
    for (const [root, lease] of leases) {
      if (subject.leaseId && lease.leaseId !== subject.leaseId) continue
      const owners = references.get(lease.leaseId)!
      owners.delete(subjectId(subject))
      if (owners.size === 0) {
        references.delete(lease.leaseId)
        leases.delete(root)
      }
    }
  }
  let leaseSequence = 0
  const deps = {
    isTauri: () => true,
    now: () => 20,
    managedBaseRoot: async () => "/data/managed-workspaces",
    getSession: async () => row,
    updateSession: jest.fn(async (_id: string, patch: Partial<ChatSession>) => {
      updates.push(patch)
      row = { ...row, ...patch }
    }),
    exists: async (path: string) => directories.has(path) || files.has(path),
    mkdir: async (path: string) => void directories.add(path),
    remove: jest.fn(async (path: string) => void directories.delete(path)),
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
    registerAllowedRoot: jest.fn(async (_path: string) => undefined),
    createProject: jest.fn((rootDir: string) => {
      const project = { id: "project-new", rootDir }
      projects.set(project.id, project)
      return project
    }),
    deleteProject: jest.fn(async (key: string) => {
      release({ kind: "project-root", key })
      projects.delete(key)
    }),
    addSessionToProject: jest.fn(),
    ensureSubjectPortLease: jest.fn(async ({ root, ...subject }: Subject & { root: string }) => {
      root = aliases.get(root) ?? root
      let lease = leases.get(root)
      if (!lease) {
        lease = {
          leaseId: `lease-${++leaseSequence}`,
          namespaceKey: "host-loopback",
          subjectKind: subject.kind,
          subjectKey: subject.key,
          canonicalRoot: root,
          registryWorkspaceId: null,
          basePort: 41000 + (leaseSequence - 1) * 10,
          portCount: 10,
          createdAt: 20,
          updatedAt: 20,
        }
        leases.set(root, lease)
        references.set(lease.leaseId, new Set())
      }
      references.get(lease.leaseId)!.add(subjectId(subject))
      return lease
    }),
    getSubjectPortLeases: jest.fn(async (subject: Subject) =>
      [...leases.values()].filter((lease) => references.get(lease.leaseId)?.has(subjectId(subject)))
    ),
    releaseSubjectPortLeases: jest.fn(async (subject: Subject & { leaseId?: string }) =>
      release(subject)
    ),
  }
  return {
    deps,
    directories,
    files,
    updates,
    leases,
    aliases,
    projects,
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
    expect(runWorkspaceUserAction).toHaveBeenCalledWith(
      "task_workspace_port_lease_subject_ensure",
      expect.any(Function)
    )
    expect(fx.deps.ensureSubjectPortLease).toHaveBeenCalledWith({
      kind: "desktop-session",
      key: "session-1",
      root: context.projectRoot,
    })
    expect(fx.deps.ensureSubjectPortLease.mock.invocationCallOrder[0]).toBeLessThan(
      fx.deps.registerAllowedRoot.mock.invocationCallOrder[0]
    )
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
    const originalLease = [...fx.leases.values()][0]
    const deleted = await deleteManagedWorkspace("session-1", fx.deps)
    expect(fx.deps.releaseSubjectPortLeases).not.toHaveBeenCalled()
    expect([...fx.leases.values()]).toEqual([originalLease])
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
    expect(fx.deps.ensureSubjectPortLease).toHaveBeenCalledTimes(2)
    expect([...fx.leases.values()]).toEqual([originalLease])
  })

  it("ensures a lease for an already materialized session", async () => {
    const fx = fixture()
    await materializeManagedWorkspace("session-1", fx.deps)
    fx.leases.clear()
    await materializeManagedWorkspace("session-1", fx.deps)
    expect(fx.deps.ensureSubjectPortLease).toHaveBeenCalledTimes(2)
    expect(fx.leases.size).toBe(1)
  })

  it("moves the subject on rebind and restores rebound folders at their original root", async () => {
    const fx = fixture()
    const original = await materializeManagedWorkspace("session-1", fx.deps)
    const originalLease = fx.leases.get(original.projectRoot)!
    fx.directories.add("/rebound")
    await rebindManagedWorkspace("session-1", "/rebound", fx.deps)
    expect(fx.deps.releaseSubjectPortLeases).toHaveBeenCalledWith({
      kind: "desktop-session",
      key: "session-1",
      leaseId: originalLease.leaseId,
    })
    expect(fx.leases.has(original.projectRoot)).toBe(false)
    const reboundLease = fx.leases.get("/rebound")
    expect(reboundLease).toBeDefined()
    expect(fx.deps.releaseSubjectPortLeases.mock.invocationCallOrder[0]).toBeGreaterThan(
      fx.deps.ensureSubjectPortLease.mock.invocationCallOrder[1]
    )
    expect(fx.deps.releaseSubjectPortLeases.mock.invocationCallOrder[0]).toBeGreaterThan(
      fx.deps.updateSession.mock.invocationCallOrder[1]
    )
    await deleteManagedWorkspace("session-1", fx.deps)
    await restoreManagedWorkspace("session-1", fx.deps)
    expect(fx.row.executionContext?.projectRoot).toBe("/rebound")
    expect(fx.leases.get("/rebound")).toEqual(reboundLease)
    expect(fx.deps.releaseSubjectPortLeases).toHaveBeenCalledTimes(1)
  })

  it("does not register or retain a newly-created folder when ensure fails", async () => {
    const fx = fixture()
    const error = new WorkspacePortLeaseError(
      "task_workspace_port_lease_subject_ensure",
      "no available port block: portRangeStart/portRangeEnd/portBlockSize"
    )
    fx.deps.ensureSubjectPortLease.mockRejectedValueOnce(error)
    await expect(materializeManagedWorkspace("session-1", fx.deps)).rejects.toBe(error)
    expect(fx.deps.registerAllowedRoot).not.toHaveBeenCalled()
    expect(fx.updates).toEqual([])
    expect(fx.directories).not.toContain("/data/managed-workspaces/managed-workspace_session-1")
    expect(fx.leases.size).toBe(0)
  })

  it("keeps the same lease when rebinding through a physical-directory alias", async () => {
    const fx = fixture()
    const original = await materializeManagedWorkspace("session-1", fx.deps)
    const lease = fx.leases.get(original.projectRoot)
    fx.directories.add("/alias")
    fx.aliases.set("/alias", original.projectRoot)
    await rebindManagedWorkspace("session-1", "/alias", fx.deps)
    expect(fx.deps.releaseSubjectPortLeases).not.toHaveBeenCalled()
    expect([...fx.leases.values()]).toEqual([lease])
    expect(fx.row.executionContext?.projectRoot).toBe("/alias")
  })

  it("moves a retained subject even when portable session metadata lost its local root", async () => {
    const fx = fixture()
    const original = await materializeManagedWorkspace("session-1", fx.deps)
    await fx.deps.updateSession("session-1", {
      executionContext: portableExecutionContext(original),
    })
    fx.directories.add("/rebound")
    await rebindManagedWorkspace("session-1", "/rebound", fx.deps)
    expect(fx.deps.releaseSubjectPortLeases).toHaveBeenCalledTimes(1)
    expect(fx.leases.has(original.projectRoot)).toBe(false)
    expect(fx.leases.has("/rebound")).toBe(true)
  })

  it("keeps pre-existing folder data when materialization ensure fails", async () => {
    const fx = fixture()
    const root = "/data/managed-workspaces/managed-workspace_session-1"
    fx.directories.add(root)
    fx.deps.ensureSubjectPortLease.mockRejectedValueOnce(new Error("lease unavailable"))
    await expect(materializeManagedWorkspace("session-1", fx.deps)).rejects.toThrow(
      "lease unavailable"
    )
    expect(fx.directories).toContain(root)
    expect(fx.deps.remove).not.toHaveBeenCalled()
  })

  it("releases a newly ensured lease and removes the folder if persistence fails", async () => {
    const fx = fixture()
    fx.deps.updateSession.mockRejectedValueOnce(new Error("write failed"))
    await expect(materializeManagedWorkspace("session-1", fx.deps)).rejects.toThrow("write failed")
    expect(fx.leases.size).toBe(0)
    expect(fx.directories).not.toContain("/data/managed-workspaces/managed-workspace_session-1")
  })

  it("keeps the old lease and numbers untouched when rebind allocation fails", async () => {
    const fx = fixture()
    const original = await materializeManagedWorkspace("session-1", fx.deps)
    const originalLease = fx.leases.get(original.projectRoot)
    fx.directories.add("/rebound")
    const error = new WorkspacePortLeaseError(
      "task_workspace_port_lease_subject_ensure",
      "allocation failed"
    )
    fx.deps.ensureSubjectPortLease.mockRejectedValueOnce(error)
    await expect(rebindManagedWorkspace("session-1", "/rebound", fx.deps)).rejects.toBe(error)
    expect(fx.leases.has(original.projectRoot)).toBe(true)
    expect(fx.leases.has("/rebound")).toBe(false)
    expect(fx.leases.get(original.projectRoot)).toEqual(originalLease)
    expect(fx.deps.releaseSubjectPortLeases).not.toHaveBeenCalled()
    expect(fx.row.executionContext?.projectRoot).toBe(original.projectRoot)
  })

  it("releases only the new reference if saving a rebind fails", async () => {
    const fx = fixture()
    const original = await materializeManagedWorkspace("session-1", fx.deps)
    const originalLease = fx.leases.get(original.projectRoot)!
    fx.directories.add("/rebound")
    fx.deps.updateSession.mockRejectedValueOnce(new Error("write failed"))
    await expect(rebindManagedWorkspace("session-1", "/rebound", fx.deps)).rejects.toThrow(
      "write failed"
    )
    expect([...fx.leases.values()]).toEqual([originalLease])
    expect(fx.row.executionContext?.projectRoot).toBe(original.projectRoot)
    expect(fx.deps.releaseSubjectPortLeases).toHaveBeenCalledWith({
      kind: "desktop-session",
      key: "session-1",
      leaseId: "lease-2",
    })
    expect(fx.deps.releaseSubjectPortLeases).not.toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: originalLease.leaseId })
    )
  })

  it("reports post-commit cleanup failure without undoing a saved rebind", async () => {
    const fx = fixture()
    await materializeManagedWorkspace("session-1", fx.deps)
    fx.directories.add("/rebound")
    fx.deps.releaseSubjectPortLeases.mockRejectedValueOnce(new Error("cleanup unavailable"))
    await expect(rebindManagedWorkspace("session-1", "/rebound", fx.deps)).rejects.toMatchObject({
      name: "ManagedWorkspacePortLeaseCleanupError",
      committed: true,
      sessionId: "session-1",
      leaseIds: ["lease-1"],
    })
    expect(fx.row.executionContext?.projectRoot).toBe("/rebound")
    expect(fx.leases.get("/rebound")?.basePort).toBe(41010)
    await materializeManagedWorkspace("session-1", fx.deps)
    expect([...fx.leases.keys()]).toEqual(["/rebound"])
    expect(fx.leases.get("/rebound")?.basePort).toBe(41010)
  })

  it.each(["materialize", "restore"] as const)(
    "keeps the committed %s folder if removing a stale reference fails",
    async (operation) => {
      const fx = fixture()
      let trashRoot: string | undefined
      if (operation === "restore") {
        await materializeManagedWorkspace("session-1", fx.deps)
        trashRoot = (await deleteManagedWorkspace("session-1", fx.deps)).managedWorkspace
          ?.deletedRoot
      }
      await fx.deps.ensureSubjectPortLease({
        kind: "desktop-session",
        key: "session-1",
        root: "/stale",
      })
      fx.deps.releaseSubjectPortLeases.mockRejectedValueOnce(new Error("cleanup unavailable"))
      const run = operation === "restore" ? restoreManagedWorkspace : materializeManagedWorkspace
      await expect(run("session-1", fx.deps)).rejects.toBeInstanceOf(
        ManagedWorkspacePortLeaseCleanupError
      )
      const savedRoot = fx.row.executionContext?.managedWorkspace?.localRoot
      expect(fx.row.executionContext?.managedWorkspace?.availability).toBe("available")
      expect(fx.directories.has(savedRoot!)).toBe(true)
      if (trashRoot) expect(fx.directories.has(trashRoot)).toBe(false)
      expect(fx.deps.remove).not.toHaveBeenCalled()
    }
  )

  it("returns a failed restore to trash and keeps its existing lease", async () => {
    const fx = fixture()
    await materializeManagedWorkspace("session-1", fx.deps)
    const lease = [...fx.leases.values()][0]
    const deleted = await deleteManagedWorkspace("session-1", fx.deps)
    const error = new WorkspacePortLeaseError(
      "task_workspace_port_lease_subject_ensure",
      "host unavailable"
    )
    fx.deps.ensureSubjectPortLease.mockRejectedValueOnce(error)
    await expect(restoreManagedWorkspace("session-1", fx.deps)).rejects.toBe(error)
    expect(fx.directories).toContain(deleted.managedWorkspace?.deletedRoot)
    expect(fx.directories).not.toContain(lease.canonicalRoot)
    expect(fx.row.executionContext?.managedWorkspace?.availability).toBe("deleted")
    expect([...fx.leases.values()]).toEqual([lease])
  })

  it("does not call host lease commands without desktop capability", async () => {
    const fx = fixture()
    fx.deps.isTauri = () => false
    await materializeManagedWorkspace("session-1", fx.deps)
    await deleteManagedWorkspace("session-1", fx.deps)
    await restoreManagedWorkspace("session-1", fx.deps)
    expect(fx.deps.getSubjectPortLeases).not.toHaveBeenCalled()
    expect(fx.deps.ensureSubjectPortLease).not.toHaveBeenCalled()
    expect(fx.deps.releaseSubjectPortLeases).not.toHaveBeenCalled()
  })

  it("recovers legacy deleted rebound folders from their retained physical-root lease", async () => {
    const fx = fixture()
    fx.directories.add("/legacy-rebound")
    await rebindManagedWorkspace("session-1", "/legacy-rebound", fx.deps)
    const lease = fx.leases.get("/legacy-rebound")
    const deleted = await deleteManagedWorkspace("session-1", fx.deps)
    await fx.deps.updateSession("session-1", {
      executionContext: {
        ...deleted,
        managedWorkspace: { ...deleted.managedWorkspace!, localRoot: undefined },
      },
    })
    await restoreManagedWorkspace("session-1", fx.deps)
    expect(fx.row.executionContext?.projectRoot).toBe("/legacy-rebound")
    expect(fx.leases.get("/legacy-rebound")).toEqual(lease)
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
    expect(
      await fx.deps.getSubjectPortLeases({ kind: "project-root", key: "project-new" })
    ).toEqual(await fx.deps.getSubjectPortLeases({ kind: "desktop-session", key: "session-1" }))
    expect(fx.deps.ensureSubjectPortLease.mock.invocationCallOrder[1]).toBeLessThan(
      fx.deps.updateSession.mock.invocationCallOrder[1]
    )
  })

  it.each(["ensure", "persist"])(
    "rolls back the new project if conversion %s fails",
    async (failure) => {
      const fx = fixture()
      const original = await materializeManagedWorkspace("session-1", fx.deps)
      const lease = fx.leases.get(original.projectRoot)
      const error = new WorkspacePortLeaseError(
        "task_workspace_port_lease_subject_ensure",
        "conversion failed"
      )
      if (failure === "ensure") fx.deps.ensureSubjectPortLease.mockRejectedValueOnce(error)
      else fx.deps.updateSession.mockRejectedValueOnce(error)
      await expect(convertManagedWorkspaceToProject("session-1", "Project", fx.deps)).rejects.toBe(
        error
      )
      expect(fx.projects.size).toBe(0)
      expect(fx.deps.deleteProject).toHaveBeenCalledWith("project-new")
      expect(fx.deps.addSessionToProject).not.toHaveBeenCalled()
      expect(fx.row.executionContext).toEqual(original)
      expect([...fx.leases.values()]).toEqual([lease])
      expect(
        await fx.deps.getSubjectPortLeases({ kind: "project-root", key: "project-new" })
      ).toEqual([])
    }
  )

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

  it("refuses scratch archival after an awaited registry read changes scope", async () => {
    const fx = scratchFixture()
    await ensureSessionScratchWorkspace(fx.row, fx.deps)
    jest.mocked(isHeadlessHost).mockReturnValue(true)
    let active = true
    jest.mocked(getWorkspaceBundle).mockImplementation(async () => {
      active = false
      return fx.bundle
    })
    await expect(
      archiveSessionScratchWorkspace(fx.row, () => {
        if (!active) throw new Error("Session database scope changed")
      })
    ).rejects.toThrow("scope changed")
    expect(getManagedWorkspace).not.toHaveBeenCalled()
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
