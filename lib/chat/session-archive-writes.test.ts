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

import { deleteSessionsRouted, setSessionsArchived } from "./session-archive-writes"

beforeEach(() => {
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
  })

  it("writes nothing locally when the Host took every id", async () => {
    enqueueMock.mockResolvedValue({ id: "job" })
    await setSessionsArchived(["a", "b"], true)
    expect(archiveSessionMock).not.toHaveBeenCalled()
    expect(bulkArchiveMock).not.toHaveBeenCalled()
  })

  it("lets a refused local write reach the caller", async () => {
    archiveSessionMock.mockRejectedValue(new Error("locked"))
    await expect(setSessionsArchived(["a"], true)).rejects.toThrow("locked")
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
  })

  it("skips the local teardown when the Host took every id", async () => {
    enqueueMock.mockResolvedValue({ id: "job" })
    await deleteSessionsRouted(["a"])
    expect(deleteWithTeardownMock).not.toHaveBeenCalled()
  })
})
