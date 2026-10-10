import type { ChatSession } from "@cognia/agent-config-types"

import type { LoadedConversationFileSpace } from "./load"
import { buildSessionMountsInput, readFileSpaceMounts, type MountTableDeps } from "./mount-table"
import type { FileSpaceDexieEntry, FileSpacePath } from "@/types/filespace"

function entry(patch: Partial<FileSpaceDexieEntry>): FileSpaceDexieEntry {
  return {
    mountId: "uploads",
    path: "/uploads/a.png" as FileSpacePath,
    name: "a.png",
    size: 5,
    mediaType: "image/png",
    createdAt: 1,
    updatedAt: 2,
    sourceId: "asset-1",
    sourceAvailable: true,
    ...patch,
  }
}

const loaded: LoadedConversationFileSpace = {
  space: {
    sessionId: "s1",
    status: "available",
    hostId: "local",
    mounts: [
      {
        id: "workspace",
        virtualPath: "/workspace",
        backing: "disk",
        label: "repo",
        hostPath: "/repo",
        managed: false,
        role: "primary",
        writable: true,
        status: "available",
      },
      {
        id: "root:docs",
        virtualPath: "/roots/docs",
        backing: "disk",
        label: "docs",
        managed: true,
        role: "additional",
        writable: true,
        status: "missing",
        statusReason: "managed-missing-on-device",
      },
      {
        id: "uploads",
        virtualPath: "/uploads",
        backing: "dexie",
        label: "Uploads",
        managed: false,
        writable: false,
        status: "available",
      },
    ],
  },
  dexie: {
    uploads: [
      entry({}),
      entry({
        path: "/uploads/a (asset-2).png" as FileSpacePath,
        sourceId: "asset-2",
      }),
      entry({
        path: "/uploads/gone.png" as FileSpacePath,
        sourceId: "asset-3",
        sourceAvailable: false,
      }),
    ],
    artifacts: [
      entry({
        mountId: "artifacts",
        path: "/artifacts/Notes.md" as FileSpacePath,
        name: "Notes.md",
        mediaType: "text/markdown",
        sourceId: "art-1",
      }),
    ],
  },
}

function deps(session: Partial<ChatSession> | undefined): MountTableDeps & {
  loadSpace: jest.Mock
} {
  return {
    getSession: jest.fn(async () => session as ChatSession | undefined),
    loadSpace: jest.fn(async () => loaded),
  }
}

describe("buildSessionMountsInput", () => {
  it("projects mounts and listable assets into the host's shape", async () => {
    const input = await buildSessionMountsInput("s1", deps({ id: "s1" }))
    expect(input.state).toBe("active")
    expect(input.mounts).toEqual([
      {
        mountId: "workspace",
        virtualPath: "/workspace",
        backing: "disk",
        hostPath: "/repo",
        writable: true,
        status: "available",
      },
      // A disk mount without a known directory is sent without one, and its
      // status says why it cannot be served.
      {
        mountId: "root:docs",
        virtualPath: "/roots/docs",
        backing: "disk",
        writable: true,
        status: "missing",
      },
      {
        mountId: "uploads",
        virtualPath: "/uploads",
        backing: "dexie",
        writable: false,
        status: "available",
      },
    ])
    // Names are the FileSpace path's last segment (disambiguated); a row
    // without its bytes is left out.
    expect(input.assets).toEqual([
      {
        mountId: "uploads",
        name: "a.png",
        size: 5,
        mediaType: "image/png",
        modifiedAt: 2,
        sourceId: "asset-1",
      },
      {
        mountId: "uploads",
        name: "a (asset-2).png",
        size: 5,
        mediaType: "image/png",
        modifiedAt: 2,
        sourceId: "asset-2",
      },
      {
        mountId: "artifacts",
        name: "Notes.md",
        size: 5,
        mediaType: "text/markdown",
        modifiedAt: 2,
        sourceId: "art-1",
      },
    ])
  })

  it("marks an archived conversation, and a missing one as deleted", async () => {
    expect((await buildSessionMountsInput("s1", deps({ id: "s1", archivedAt: 5 }))).state).toBe(
      "archived"
    )
    const missing = deps(undefined)
    await expect(buildSessionMountsInput("s1", missing)).resolves.toEqual({
      sessionId: "s1",
      state: "deleted",
      mounts: [],
      assets: [],
    })
    expect(missing.loadSpace).not.toHaveBeenCalled()
  })
})

describe("readFileSpaceMounts", () => {
  it("refuses a request that names no conversation", async () => {
    await expect(
      readFileSpaceMounts({ requestId: "r", kind: "filespace_mounts", sessionId: "" }, deps({}))
    ).rejects.toThrow("names no conversation")
  })

  it("answers for the conversation the host named", async () => {
    const d = deps({ id: "s1" })
    const input = await readFileSpaceMounts(
      { requestId: "r", kind: "filespace_mounts", sessionId: "s1" },
      d
    )
    expect(input.sessionId).toBe("s1")
    expect(d.getSession).toHaveBeenCalledWith("s1")
  })
})
