import type { ChatSession } from "@cognia/agent-config-types"
import {
  createManagedWorkspaceArchive,
  createManagedWorkspaceContext,
  convertManagedWorkspaceToProject,
  deleteManagedWorkspace,
  importManagedWorkspaceArchive,
  materializeManagedWorkspace,
  portableExecutionContext,
  rebindManagedWorkspace,
  restoreManagedWorkspace,
} from "./managed-workspace"

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    title: "Task",
    createdAt: new Date(0),
    updatedAt: new Date(0),
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
  return { deps, directories, files, updates, get row() { return row } }
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
