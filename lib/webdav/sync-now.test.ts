const buildMock = jest.fn(async (..._a: unknown[]) => ({
  manifest: {
    version: "3.0",
    schemaVersion: 1,
    traceId: "t",
    exportedAt: "2026-05-30T00:00:00.000Z",
    appVersion: "0.1.0",
    backend: "tauri-dexie",
  },
  payload: {},
}))
const uploadMock = jest.fn(
  async (..._a: unknown[]): Promise<{ ok: boolean; remotePath?: string; error?: string }> => ({
    ok: true,
    remotePath: "/r",
  })
)
const appendMock = jest.fn(async (..._a: unknown[]) => ({}))
const saveSettingsMock = jest.fn(async (..._a: unknown[]) => {})
const setSyncPassphraseMock = jest.fn()
const encryptBodyMock = jest.fn(async (..._a: unknown[]) => "ENC")
const getSyncPassphraseMock = jest.fn<string | null, []>(() => null)
const attachPortableRetrievalKeysMock = jest.fn(async (pkg: unknown) => pkg)

jest.mock("@/lib/data/build-package", () => ({
  buildBackupPackage: (...a: unknown[]) => buildMock(...a),
  serializePackage: () => "PLAIN",
}))
jest.mock("@/lib/data/destinations/webdav", () => ({
  uploadSnapshotToWebDav: (...a: unknown[]) => uploadMock(...a),
  webdavSnapshotName: (iso: string) => `cognia-backup-${iso}.enc.cbk`,
  encryptSnapshotBody: (...a: unknown[]) => encryptBodyMock(...a),
}))
jest.mock("@/lib/data/retrieval-key-backup", () => ({
  attachPortableRetrievalKeys: (pkg: unknown, passphrase: string) =>
    attachPortableRetrievalKeysMock(pkg, passphrase),
}))
jest.mock("@/lib/db/backup-history", () => ({
  appendBackupHistory: (...a: unknown[]) => appendMock(...a),
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => ({ webdavSync: { enabled: true } }),
  saveSettings: (...a: unknown[]) => saveSettingsMock(...a),
}))
jest.mock("./passphrase-cache", () => ({
  setSyncPassphrase: (...a: unknown[]) => setSyncPassphraseMock(...a),
  getSyncPassphrase: () => getSyncPassphraseMock(),
  persistSyncPassphrase: jest.fn(async () => undefined),
}))

import { runWebDavSyncNow } from "./sync-now"

beforeEach(() => {
  uploadMock.mockClear()
  uploadMock.mockResolvedValue({ ok: true, remotePath: "/r" })
  appendMock.mockClear()
  saveSettingsMock.mockClear()
  setSyncPassphraseMock.mockClear()
  encryptBodyMock.mockClear()
  getSyncPassphraseMock.mockReset()
  getSyncPassphraseMock.mockReturnValue(null)
  attachPortableRetrievalKeysMock.mockClear()
})

describe("runWebDavSyncNow", () => {
  it("requires a passphrase when none is given and none is cached", async () => {
    expect(await runWebDavSyncNow("")).toEqual({ ok: false, error: expect.any(String) })
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it("falls back to the cached session passphrase when the input is empty", async () => {
    getSyncPassphraseMock.mockReturnValue("cached-pass")
    const result = await runWebDavSyncNow("")
    expect(result).toEqual({ ok: true })
    // The cached passphrase is what encrypts + re-caches the snapshot.
    expect(encryptBodyMock).toHaveBeenCalledWith("PLAIN", expect.anything(), "cached-pass")
    expect(attachPortableRetrievalKeysMock).toHaveBeenCalledWith(expect.anything(), "cached-pass")
    expect(uploadMock).toHaveBeenCalled()
    expect(setSyncPassphraseMock).toHaveBeenCalledWith("cached-pass")
  })

  it("uploads, records a manual success row, caches the passphrase + stamps", async () => {
    const result = await runWebDavSyncNow("p")
    expect(result).toEqual({ ok: true })
    expect(uploadMock).toHaveBeenCalled()
    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "manual", success: true, encryption: "passphrase" })
    )
    expect(setSyncPassphraseMock).toHaveBeenCalledWith("p")
    expect(saveSettingsMock).toHaveBeenCalled()
  })

  it("records a failure row and does not cache the passphrase on upload failure", async () => {
    uploadMock.mockResolvedValueOnce({ ok: false, error: "boom" })
    const result = await runWebDavSyncNow("p")
    expect(result).toEqual({ ok: false, error: "boom" })
    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorMessage: "boom" })
    )
    expect(setSyncPassphraseMock).not.toHaveBeenCalled()
    expect(saveSettingsMock).not.toHaveBeenCalled()
  })

  it("supports an auto history type and reports coarse progress phases", async () => {
    const phases: string[] = []
    const result = await runWebDavSyncNow("p", {
      historyType: "auto",
      onProgress: (phase) => phases.push(phase),
    })
    expect(result).toEqual({ ok: true })
    expect(appendMock).toHaveBeenCalledWith(expect.objectContaining({ type: "auto" }))
    expect(phases).toEqual(["building", "encrypting", "uploading", "done"])
  })

  it("treats a lastSyncAt stamp failure as non-fatal", async () => {
    saveSettingsMock.mockRejectedValueOnce(new Error("dexie closed"))
    const result = await runWebDavSyncNow("p")
    expect(result).toEqual({ ok: true })
  })
})
