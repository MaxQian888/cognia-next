const uploadMock = jest.fn(
  async (..._args: unknown[]): Promise<{ ok: boolean; remotePath?: string; error?: string }> => ({
    ok: true,
    remotePath: "/cognia-backups/x.enc.cbk",
  })
)
jest.mock("./webdav", () => ({
  uploadSnapshotToWebDav: (...args: unknown[]) => uploadMock(...args),
}))

import { dispatchBackupDestination } from "./index"

const meta = { filename: "f", exportedAt: "2026-05-30T00:00:00.000Z", sizeBytes: 1 }

beforeEach(() => {
  uploadMock.mockClear()
  uploadMock.mockResolvedValue({ ok: true, remotePath: "/cognia-backups/x.enc.cbk" })
})

describe("dispatchBackupDestination", () => {
  it("treats local / undefined as a no-op handled by the caller", async () => {
    expect(await dispatchBackupDestination(undefined, "b", meta)).toEqual({
      ok: true,
      target: "local",
    })
    expect(await dispatchBackupDestination("local", "b", meta)).toEqual({
      ok: true,
      target: "local",
    })
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it("uploads for webdav and all", async () => {
    const webdav = await dispatchBackupDestination("webdav", "b", meta)
    expect(webdav).toEqual({ ok: true, target: "/cognia-backups/x.enc.cbk" })
    await dispatchBackupDestination("all", "b", meta)
    expect(uploadMock).toHaveBeenCalledTimes(2)
  })

  it("surfaces upload failure", async () => {
    uploadMock.mockResolvedValueOnce({ ok: false, error: "boom" })
    expect(await dispatchBackupDestination("webdav", "b", meta)).toEqual({
      ok: false,
      error: "boom",
    })
  })

  it("rejects unsupported clouds", async () => {
    const result = await dispatchBackupDestination("convex", "b", meta)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not supported/i)
  })
})
