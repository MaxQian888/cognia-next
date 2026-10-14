const enqueueMock = jest.fn()
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueHostStateIntentIfAvailable: (input: unknown) => enqueueMock(input),
}))

const archiveSessionMock = jest.fn()
const unarchiveSessionMock = jest.fn()
const bulkArchiveMock = jest.fn()
const bulkUnarchiveMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  archiveSession: (id: string) => archiveSessionMock(id),
  unarchiveSession: (id: string) => unarchiveSessionMock(id),
  bulkArchiveSessions: (ids: readonly string[]) => bulkArchiveMock(ids),
  bulkUnarchiveSessions: (ids: readonly string[]) => bulkUnarchiveMock(ids),
}))

const deleteWithTeardownMock = jest.fn()
jest.mock("@/lib/chat/session-deletion", () => ({
  deleteSessionsWithTeardown: (ids: readonly string[]) => deleteWithTeardownMock(ids),
}))

const announceMock = jest.fn()
const archiveScratchMock = jest.fn()
jest.mock("@/lib/task-workspace/managed-workspace", () => ({
  archiveSessionScratchWorkspace: (id: string) => archiveScratchMock(id),
}))
jest.mock("@/lib/filespace/lifecycle", () => ({
  announceFileSpaceSessionsChanged: (ids: readonly string[]) => announceMock(ids),
}))

import { deleteSessionsRouted, setSessionsArchived } from "./session-archive-writes"

beforeEach(() => {
  archiveScratchMock.mockReset().mockResolvedValue(undefined)
  announceMock.mockReset()
  enqueueMock.mockReset().mockResolvedValue(null)
  for (const mock of [
    archiveSessionMock,
    unarchiveSessionMock,
    bulkArchiveMock,
    bulkUnarchiveMock,
    deleteWithTeardownMock,
  ]) {
    mock.mockReset().mockResolvedValue(undefined)
  }
})

describe("setSessionsArchived", () => {
  it("writes nothing for an empty id list", async () => {
    await setSessionsArchived([], true)
    expect(enqueueMock).not.toHaveBeenCalled()
    expect(archiveSessionMock).not.toHaveBeenCalled()
    expect(bulkArchiveMock).not.toHaveBeenCalled()
  })

  it("archives one local row through the single-row writer", async () => {
    await setSessionsArchived(["a"], true)
    expect(enqueueMock).toHaveBeenCalledWith({
      sessionId: "a",
      action: { kind: "session.archive", archived: true },
    })
    expect(archiveSessionMock).toHaveBeenCalledWith("a")
    expect(bulkArchiveMock).not.toHaveBeenCalled()
  })

  it("restores one local row through the single-row writer", async () => {
    await setSessionsArchived(["a"], false)
    expect(enqueueMock).toHaveBeenCalledWith({
      sessionId: "a",
      action: { kind: "session.archive", archived: false },
    })
    expect(unarchiveSessionMock).toHaveBeenCalledWith("a")
    expect(archiveScratchMock).not.toHaveBeenCalled()
  })

  it("writes several local rows in one bulk transaction, each id once", async () => {
    await setSessionsArchived(["a", "b", "a"], true)
    expect(enqueueMock).toHaveBeenCalledTimes(2)
    expect(bulkArchiveMock).toHaveBeenCalledWith(["a", "b"])
    await setSessionsArchived(["a", "b"], false)
    expect(bulkUnarchiveMock).toHaveBeenCalledWith(["a", "b"])
  })

  it("leaves the ids a Host queued to the Host", async () => {
    enqueueMock.mockImplementation(async (input: { sessionId: string }) =>
      input.sessionId === "hosted" ? { id: "job" } : null
    )
    await setSessionsArchived(["hosted", "local"], true)
    expect(archiveSessionMock).toHaveBeenCalledWith("local")
    expect(bulkArchiveMock).not.toHaveBeenCalled()
    // Only what this device wrote reaches its own file-share host.
    expect(announceMock).toHaveBeenCalledWith(["local"])
    expect(archiveScratchMock.mock.calls).toEqual([["local"]])
    expect(archiveScratchMock.mock.invocationCallOrder[0]).toBeLessThan(
      archiveSessionMock.mock.invocationCallOrder[0]
    )
  })

  it("tells the file-share host about every local archive and restore", async () => {
    await setSessionsArchived(["a", "b"], true)
    expect(announceMock).toHaveBeenLastCalledWith(["a", "b"])
    await setSessionsArchived(["a"], false)
    expect(announceMock).toHaveBeenLastCalledWith(["a"])
  })

  it("writes nothing locally when the Host took every id", async () => {
    archiveScratchMock.mockRejectedValue(new Error("host offline"))
    enqueueMock.mockResolvedValue({ id: "job" })
    await setSessionsArchived(["a", "b"], true)
    expect(archiveSessionMock).not.toHaveBeenCalled()
    expect(bulkArchiveMock).not.toHaveBeenCalled()
    expect(archiveScratchMock).not.toHaveBeenCalled()
    expect(enqueueMock).toHaveBeenCalledTimes(2)
    expect(announceMock).not.toHaveBeenCalled()
  })

  it("lets a refused local write reach the caller", async () => {
    archiveSessionMock.mockRejectedValue(new Error("locked"))
    await expect(setSessionsArchived(["a"], true)).rejects.toThrow("locked")
    expect(announceMock).not.toHaveBeenCalled()
  })

  it("preserves the session row if scratch archival fails", async () => {
    archiveScratchMock.mockRejectedValue(new Error("snapshot failed"))
    await expect(setSessionsArchived(["a"], true)).rejects.toThrow("snapshot failed")
    expect(archiveSessionMock).not.toHaveBeenCalled()
  })
})

describe("deleteSessionsRouted", () => {
  it("deletes nothing for an empty id list", async () => {
    await deleteSessionsRouted([])
    expect(enqueueMock).not.toHaveBeenCalled()
    expect(deleteWithTeardownMock).not.toHaveBeenCalled()
  })

  it("hands every delete to a Host first, and tears down the rest here", async () => {
    enqueueMock.mockImplementation(async (input: { sessionId: string }) =>
      input.sessionId === "hosted" ? { id: "job" } : null
    )
    await deleteSessionsRouted(["hosted", "x", "y", "x"])
    expect(enqueueMock).toHaveBeenCalledWith({
      sessionId: "hosted",
      action: { kind: "session.delete" },
    })
    expect(deleteWithTeardownMock).toHaveBeenCalledWith(["x", "y"])
    expect(archiveScratchMock.mock.calls).toEqual([["x"], ["y"]])
    expect(archiveScratchMock.mock.invocationCallOrder[1]).toBeLessThan(
      deleteWithTeardownMock.mock.invocationCallOrder[0]
    )
  })

  it("skips the local teardown when the Host took every id", async () => {
    archiveScratchMock.mockRejectedValue(new Error("host offline"))
    enqueueMock.mockResolvedValue({ id: "job" })
    await deleteSessionsRouted(["a"])
    expect(deleteWithTeardownMock).not.toHaveBeenCalled()
    expect(archiveScratchMock).not.toHaveBeenCalled()
  })

  it("keeps the identity row when scratch archival fails before deletion", async () => {
    archiveScratchMock.mockRejectedValue(new Error("snapshot failed"))
    await expect(deleteSessionsRouted(["a"])).rejects.toThrow("snapshot failed")
    expect(deleteWithTeardownMock).not.toHaveBeenCalled()
  })
})
