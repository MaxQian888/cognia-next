/** @jest-environment jsdom */
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(() => false),
}))

import { isTauri } from "@/lib/tauri"
import type { WorkspaceStat } from "@/lib/files/types"
import type { WorkspaceFileChunk } from "@/lib/files/workspace-fs"
import type { ConversationFileSpace } from "@/types/filespace"
import type { LoadedConversationFileSpace } from "@/lib/filespace/load"
import {
  FilesWorkspaceFileError,
  hasLocalWorkspaceFiles,
  loadWorkspaceFileIndex,
  locateWorkspaceFile,
  openWorkspaceFileInConversation,
  readWorkspaceFileBytes,
  readWorkspaceFileSlice,
} from "./workspace-files-io"

const location = {
  sessionId: "s1",
  workspaceRoot: "/repo",
  executionRoot: "/exec/run-1",
  relPath: "docs/plan.md",
}

const file = (size: number): WorkspaceStat => ({ exists: true, isDir: false, size, mtimeMs: 1 })
const absent: WorkspaceStat = { exists: false, isDir: false, size: 0, mtimeMs: 0 }

/** A disk whose files are the given byte arrays, keyed by `<root>|<relPath>`. */
function disk(files: Record<string, Uint8Array>, chunk = 4) {
  const stat = jest.fn(async (root: string, relPath: string) => {
    if (root === "/broken") throw new Error("root refused")
    const bytes = files[`${root}|${relPath}`]
    return bytes ? file(bytes.byteLength) : absent
  })
  const readChunk = jest.fn(
    async (root: string, relPath: string, offset: number, length: number) => {
      const bytes = files[`${root}|${relPath}`]!
      const slice = bytes.slice(offset, offset + Math.min(length, chunk))
      return {
        dataBase64: btoa(String.fromCharCode(...slice)),
        offset,
        bytesRead: slice.byteLength,
        size: bytes.byteLength,
        eof: offset + slice.byteLength >= bytes.byteLength,
      } satisfies WorkspaceFileChunk
    }
  )
  return { stat, readChunk }
}

describe("where workspace files are listed", () => {
  it("is the desktop app only", () => {
    expect(hasLocalWorkspaceFiles()).toBe(false)
    ;(isTauri as jest.Mock).mockReturnValueOnce(true)
    expect(hasLocalWorkspaceFiles()).toBe(true)
  })

  it("reads the ledger's index, or null when it cannot be asked", async () => {
    await expect(loadWorkspaceFileIndex({ list: async () => [] })).resolves.toEqual([])
    await expect(
      loadWorkspaceFileIndex({
        list: async () => {
          throw new Error("no service")
        },
      })
    ).resolves.toBeNull()
  })
})

describe("locateWorkspaceFile", () => {
  it("tries the run's own root first, then the workspace root", async () => {
    const both = disk({
      "/exec/run-1|docs/plan.md": new Uint8Array(3),
      "/repo|docs/plan.md": new Uint8Array(5),
    })
    await expect(locateWorkspaceFile(location, both)).resolves.toEqual({
      root: "/exec/run-1",
      relPath: "docs/plan.md",
      size: 3,
    })
    // The run's root is gone once its changes were applied back.
    const applied = disk({ "/repo|docs/plan.md": new Uint8Array(5) })
    await expect(locateWorkspaceFile(location, applied)).resolves.toMatchObject({ root: "/repo" })
    // A root the host refuses is skipped like a missing one.
    await expect(
      locateWorkspaceFile({ ...location, executionRoot: "/broken" }, applied)
    ).resolves.toMatchObject({ root: "/repo" })
    await expect(locateWorkspaceFile(location, disk({}))).resolves.toBeNull()
  })

  it("does not take a directory for the file", async () => {
    const stat = jest.fn(async () => ({ exists: true, isDir: true, size: 0, mtimeMs: 0 }))
    await expect(locateWorkspaceFile(location, { stat })).resolves.toBeNull()
  })
})

describe("reading a workspace file", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

  it("reads it whole, a chunk at a time, from where it is now", async () => {
    const d = disk({ "/repo|docs/plan.md": bytes })
    await expect(readWorkspaceFileBytes(location, {}, d)).resolves.toEqual(bytes)
    expect(d.readChunk.mock.calls.map((call) => call[2])).toEqual([0, 4, 8])
  })

  it("refuses a file over the ceiling before reading it, and one that grew past it", async () => {
    const d = disk({ "/repo|docs/plan.md": bytes })
    await expect(readWorkspaceFileBytes(location, { maxBytes: 9 }, d)).rejects.toEqual(
      new FilesWorkspaceFileError("files_workspace_too_large")
    )
    expect(d.readChunk).not.toHaveBeenCalled()
    const grew = disk({ "/repo|docs/plan.md": bytes })
    grew.stat.mockResolvedValueOnce(absent).mockResolvedValueOnce(file(4))
    await expect(readWorkspaceFileBytes(location, { maxBytes: 6 }, grew)).rejects.toMatchObject({
      code: "files_workspace_too_large",
    })
  })

  it("says the file is missing when neither root holds it", async () => {
    await expect(readWorkspaceFileBytes(location, {}, disk({}))).rejects.toMatchObject({
      code: "files_workspace_missing",
    })
    await expect(readWorkspaceFileSlice(location, 0, 4, disk({}))).rejects.toMatchObject({
      code: "files_workspace_missing",
    })
  })

  it("reads one slice for a paired device", async () => {
    const d = disk({ "/repo|docs/plan.md": bytes }, 1024)
    await expect(readWorkspaceFileSlice(location, 8, 4, d)).resolves.toEqual({
      bytes: new Uint8Array([9, 10]),
      size: 10,
      eof: true,
    })
  })
})

describe("openWorkspaceFileInConversation", () => {
  function space(hostPath: string, status: ConversationFileSpace["status"] = "available") {
    return async (): Promise<LoadedConversationFileSpace> => ({
      space: {
        sessionId: "s1",
        status,
        hostId: "local",
        mounts: [
          {
            id: "workspace",
            virtualPath: "/workspace",
            backing: "disk",
            label: "repo",
            hostPath,
            managed: false,
            writable: true,
            status: "available",
          },
        ],
      } as ConversationFileSpace,
      dexie: { uploads: [], artifacts: [] },
    })
  }
  const navigator = { push: jest.fn() }
  const entry = { workspace: { ...location, change: "created" as const } }

  it("goes to the conversation and opens the file in its Files panel", async () => {
    const goTo = jest.fn(async () => undefined)
    const openPath = jest.fn(async () => "opened" as const)
    const d = disk({ "/repo|docs/plan.md": new Uint8Array(1) })
    await expect(
      openWorkspaceFileInConversation(entry, navigator, {
        ...d,
        loadSpace: space("/repo"),
        goTo,
        openPath,
      })
    ).resolves.toBe("opened")
    expect(goTo).toHaveBeenCalledWith("s1", navigator)
    expect(openPath).toHaveBeenCalledWith({ sessionId: "s1", path: "/workspace/docs/plan.md" })
  })

  it("previews in place a file outside the conversation's FileSpace, without leaving", async () => {
    const goTo = jest.fn(async () => undefined)
    const d = disk({ "/exec/run-1|docs/plan.md": new Uint8Array(1) })
    await expect(
      openWorkspaceFileInConversation(entry, navigator, { ...d, loadSpace: space("/repo"), goTo })
    ).resolves.toBe("outside")
    await expect(
      openWorkspaceFileInConversation(entry, navigator, {
        ...d,
        loadSpace: space("/exec/run-1", "deleted"),
        goTo,
      })
    ).resolves.toBe("outside")
    expect(goTo).not.toHaveBeenCalled()
  })

  it("says so when the file is gone or its workspace cannot be reached", async () => {
    const loadSpace = space("/repo")
    await expect(
      openWorkspaceFileInConversation(entry, navigator, { ...disk({}), loadSpace })
    ).rejects.toMatchObject({ code: "files_workspace_missing" })
    const d = disk({ "/repo|docs/plan.md": new Uint8Array(1) })
    const goTo = jest.fn(async () => undefined)
    await expect(
      openWorkspaceFileInConversation(entry, navigator, {
        ...d,
        loadSpace,
        goTo,
        openPath: async () => "not-found",
      })
    ).rejects.toMatchObject({ code: "files_workspace_missing" })
    await expect(
      openWorkspaceFileInConversation(entry, navigator, {
        ...d,
        loadSpace,
        goTo,
        openPath: async () => "offline",
      })
    ).rejects.toMatchObject({ code: "files_workspace_unavailable" })
    await expect(
      openWorkspaceFileInConversation(entry, navigator, {
        ...d,
        loadSpace,
        goTo,
        openPath: async () => "session-changed",
      })
    ).resolves.toBe("session-changed")
    await expect(openWorkspaceFileInConversation({}, navigator, d)).rejects.toMatchObject({
      code: "files_workspace_missing",
    })
  })
})
