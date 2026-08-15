/** @jest-environment jsdom */
jest.mock("@/lib/data/build-package", () => ({
  buildBackupPackage: async () => ({
    manifest: { exportedAt: "2026-08-16T02:00:00.000Z", device: { id: "d", label: "L" } },
  }),
  serializePackage: () => "plaintext",
}))
jest.mock("@/lib/data/retrieval-key-backup", () => ({
  attachPortableRetrievalKeys: async (pkg: unknown) => pkg,
}))
jest.mock("./webdav", () => ({
  ...jest.requireActual("./webdav"),
  encryptSnapshotBody: async () => "envelope",
}))
const appendMock = jest.fn(async (row: unknown) => row)
jest.mock("@/lib/db/backup-history", () => ({
  appendBackupHistory: (row: unknown) => appendMock(row),
}))
const cache = { pass: null as string | null }
const setPassMock = jest.fn((p: string) => {
  cache.pass = p
})
const persistMock = jest.fn(async () => undefined)
jest.mock("@/lib/webdav/passphrase-cache", () => ({
  getSyncPassphrase: () => cache.pass,
  setSyncPassphrase: (p: string) => setPassMock(p),
  persistSyncPassphrase: () => persistMock(),
}))

import { runRemoteBackupSyncNow } from "./sync-now"

beforeEach(() => {
  cache.pass = null
  jest.clearAllMocks()
})

describe("runRemoteBackupSyncNow", () => {
  it("requires a passphrase (explicit or cached)", async () => {
    expect(await runRemoteBackupSyncNow("github", "", { dispatch: jest.fn() })).toEqual({
      ok: false,
      error: "A sync passphrase is required.",
    })
  })

  it("builds, encrypts, dispatches, records history and caches the passphrase", async () => {
    const dispatch = jest.fn(async () => ({ ok: true, target: "o/r:x" }))
    const phases: string[] = []
    const result = await runRemoteBackupSyncNow("github", "pw", {
      dispatch,
      onProgress: (p) => phases.push(p),
    })
    expect(result).toEqual({ ok: true, target: "o/r:x" })
    expect(dispatch).toHaveBeenCalledWith("github", "envelope", {
      filename: "cognia-backup-2026-08-16T02-00-00-000Z.enc.cbk",
      exportedAt: "2026-08-16T02:00:00.000Z",
      sizeBytes: "envelope".length,
    })
    expect(phases).toEqual(["building", "encrypting", "uploading", "done"])
    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "manual",
        success: true,
        encryption: "passphrase",
        destination: "github",
        deviceLabel: "L",
      })
    )
    expect(setPassMock).toHaveBeenCalledWith("pw")
    expect(persistMock).toHaveBeenCalled()
  })

  it("uses the cached passphrase and reports failures without caching", async () => {
    cache.pass = "cached"
    const dispatch = jest.fn(async () => ({ ok: false, error: "quota" }))
    expect(
      await runRemoteBackupSyncNow("googledrive", "", { dispatch, historyType: "auto" })
    ).toEqual({
      ok: false,
      error: "quota",
    })
    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "auto",
        success: false,
        errorMessage: "quota",
        destination: "googledrive",
      })
    )
    expect(setPassMock).not.toHaveBeenCalled()
    const noError = jest.fn(async () => ({ ok: false }))
    expect(await runRemoteBackupSyncNow("webdav", "", { dispatch: noError })).toEqual({
      ok: false,
      error: "Upload failed.",
    })
  })
})
