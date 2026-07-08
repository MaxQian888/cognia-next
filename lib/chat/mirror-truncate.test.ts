const deleteMessageMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/claude/ipc", () => ({
  deleteMessage: (...a: unknown[]) => deleteMessageMock(...a),
}))

const getMock = jest.fn()
const primaryKeysMock = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    messages: {
      get: (id: string) => getMock(id),
      where: () => ({ between: () => ({ primaryKeys: () => primaryKeysMock() }) }),
    },
  }),
}))

import { mirrorTruncateToDesktop } from "./mirror-truncate"

beforeEach(() => {
  deleteMessageMock.mockClear().mockResolvedValue(undefined)
  getMock.mockReset()
  primaryKeysMock.mockReset()
})

describe("mirrorTruncateToDesktop", () => {
  it("fans out deleteMessage for the anchor and everything after it", async () => {
    getMock.mockResolvedValue({ id: "m2", sessionId: "s1", createdAt: 20 })
    primaryKeysMock.mockResolvedValue(["m2", "m3"])
    await mirrorTruncateToDesktop("s1", "m2")
    expect(deleteMessageMock).toHaveBeenCalledWith("s1", "m2")
    expect(deleteMessageMock).toHaveBeenCalledWith("s1", "m3")
  })

  it("is a no-op when the anchor is missing or belongs to another session", async () => {
    getMock.mockResolvedValueOnce(undefined)
    await mirrorTruncateToDesktop("s1", "ghost")
    getMock.mockResolvedValueOnce({ id: "m2", sessionId: "OTHER", createdAt: 20 })
    await mirrorTruncateToDesktop("s1", "m2")
    expect(deleteMessageMock).not.toHaveBeenCalled()
  })

  it("swallows per-message and top-level failures (best-effort)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    getMock.mockResolvedValue({ id: "m2", sessionId: "s1", createdAt: 20 })
    primaryKeysMock.mockResolvedValue(["m2", "m3"])
    deleteMessageMock.mockRejectedValueOnce(new Error("rpc down"))
    await expect(mirrorTruncateToDesktop("s1", "m2")).resolves.toBeUndefined()
    // The second delete still ran after the first failed.
    expect(deleteMessageMock).toHaveBeenCalledWith("s1", "m3")

    getMock.mockRejectedValueOnce(new Error("db closed"))
    await expect(mirrorTruncateToDesktop("s1", "m2")).resolves.toBeUndefined()
    warn.mockRestore()
  })
})
