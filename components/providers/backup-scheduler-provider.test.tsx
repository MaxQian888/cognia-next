// Focused test for the WebDAV upload branch added to the interval scheduler.
// The local-disk path is covered indirectly; here we only exercise
// `maybeUploadToWebDav`, the new code this change introduced.

import type { BackupPackageV3 } from "@/lib/data/types"

const appendBackupHistoryMock = jest.fn(async (..._a: unknown[]) => ({}) as never)
const getSettingsMock = jest.fn(async (..._a: unknown[]) => ({ webdavSync: {} }) as never)
const saveSettingsMock = jest.fn(async (..._a: unknown[]) => {})
const uploadMock = jest.fn(
  async (..._a: unknown[]): Promise<{ ok: boolean; remotePath?: string; error?: string }> => ({
    ok: true,
    remotePath: "/r",
  })
)
let hasPass = false
let syncPass: string | null = null

jest.mock("@/lib/db/backup-history", () => ({
  appendBackupHistory: (...a: unknown[]) => appendBackupHistoryMock(...a),
  getLatestSuccessful: async () => undefined,
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: (...a: unknown[]) => getSettingsMock(...a),
  saveSettings: (...a: unknown[]) => saveSettingsMock(...a),
}))
jest.mock("@/lib/data/destinations/webdav", () => ({
  uploadSnapshotToWebDav: (...a: unknown[]) => uploadMock(...a),
  webdavSnapshotName: (iso: string) => `cognia-backup-${iso}.enc.cbk`,
  encryptSnapshotBody: async () => "ENC",
}))
jest.mock("@/lib/webdav/passphrase-cache", () => ({
  hasSyncPassphrase: () => hasPass,
  getSyncPassphrase: () => syncPass,
}))

import { maybeUploadToWebDav } from "./backup-scheduler-provider"

const pkg = {
  version: "3.0",
  manifest: {
    version: "3.0",
    schemaVersion: 1,
    traceId: "t",
    exportedAt: "2026-05-30T00:00:00.000Z",
    appVersion: "0.1.0",
    backend: "tauri-dexie",
    integrity: { algorithm: "SHA-256", checksum: "c" },
  },
  payload: {},
} as unknown as BackupPackageV3

beforeEach(() => {
  appendBackupHistoryMock.mockClear()
  saveSettingsMock.mockClear()
  uploadMock.mockClear()
  uploadMock.mockResolvedValue({ ok: true, remotePath: "/r" })
  hasPass = false
  syncPass = null
})

describe("maybeUploadToWebDav", () => {
  it("no-ops when sync is disabled", async () => {
    await maybeUploadToWebDav(false, pkg, "plain")
    expect(uploadMock).not.toHaveBeenCalled()
    expect(appendBackupHistoryMock).not.toHaveBeenCalled()
  })

  it("records a failure row when enabled but locked", async () => {
    hasPass = false
    await maybeUploadToWebDav(true, pkg, "plain")
    expect(uploadMock).not.toHaveBeenCalled()
    expect(appendBackupHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, encryption: "passphrase" })
    )
  })

  it("uploads + stamps lastSyncAt when unlocked", async () => {
    hasPass = true
    syncPass = "p"
    await maybeUploadToWebDav(true, pkg, "plain")
    expect(uploadMock).toHaveBeenCalledTimes(1)
    expect(appendBackupHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, encryption: "passphrase" })
    )
    expect(saveSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        webdavSync: expect.objectContaining({ lastSyncAt: expect.any(String) }),
      })
    )
  })

  it("records a failure row when the upload fails", async () => {
    hasPass = true
    syncPass = "p"
    uploadMock.mockResolvedValueOnce({ ok: false, error: "boom" })
    await maybeUploadToWebDav(true, pkg, "plain")
    expect(appendBackupHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, encryption: "passphrase", errorMessage: "boom" })
    )
    expect(saveSettingsMock).not.toHaveBeenCalled()
  })
})
