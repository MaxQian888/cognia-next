/** @jest-environment node */

const mockGetSettings = jest.fn()
const mockSaveSettings = jest.fn(async (_input?: unknown) => undefined)
const mockAppendHistory = jest.fn(async (_input?: unknown) => undefined)
const mockGetLatestSuccessful = jest.fn(async (): Promise<unknown> => undefined)
const mockBuildPackage = jest.fn()
const mockBuildStream = jest.fn()
jest.mock("./build-stream", () => ({
  buildBackupStream: (...args: unknown[]) => mockBuildStream(...args),
}))
const mockGetAutoKey = jest.fn(async (): Promise<string | null> => "auto-key")
const mockShouldRun = jest.fn((_input?: unknown) => true)
const mockPrune = jest.fn()
const mockUpload = jest.fn()
const mockEncrypt = jest.fn(
  async (_plaintext?: unknown, _pkg?: unknown, _passphrase?: unknown) => "encrypted"
)
const mockHasSyncPassphrase = jest.fn(() => false)
const mockGetSyncPassphrase = jest.fn((): string | null => null)
const mockLoadPersistedSyncPassphrase = jest.fn(async () => false)
const mockNotifyRemoteNewer = jest.fn(async (_input?: unknown) => false)
const mockAttachPortableRetrievalKeys = jest.fn(
  async (value: unknown, _passphrase: string) => value
)

jest.mock("@/lib/db/settings", () => ({
  getSettings: () => mockGetSettings(),
  saveSettings: (input: unknown) => mockSaveSettings(input),
}))
jest.mock("@/lib/db/backup-history", () => ({
  appendBackupHistory: (input: unknown) => mockAppendHistory(input),
  getLatestSuccessful: () => mockGetLatestSuccessful(),
}))
jest.mock("@/lib/data/build-package", () => ({
  buildBackupPackage: (options: unknown) => mockBuildPackage(options),
  serializePackage: () => "plain",
  defaultExportFileName: () => "cognia-backup-2026-07-19.enc.cbk",
}))
jest.mock("@/lib/data/backup-key", () => ({
  getDefaultBackupPassphrase: () => mockGetAutoKey(),
}))
jest.mock("@/lib/data/retrieval-key-backup", () => ({
  attachPortableRetrievalKeys: (value: unknown, passphrase: string) =>
    mockAttachPortableRetrievalKeys(value, passphrase),
}))
jest.mock("@/lib/data/scheduler", () => ({
  shouldRunScheduledBackup: (input: unknown) => mockShouldRun(input),
  pruneScheduledBackups: (candidates: unknown, retainCount: unknown) =>
    mockPrune(candidates, retainCount),
}))
jest.mock("@/lib/data/destinations/webdav", () => ({
  encryptSnapshotBody: (plaintext: unknown, pkg: unknown, passphrase: unknown) =>
    mockEncrypt(plaintext, pkg, passphrase),
  uploadSnapshotToWebDav: (body: unknown, metadata: unknown) => mockUpload(body, metadata),
  webdavSnapshotName: () => "remote.enc.cbk",
}))
jest.mock("@/lib/webdav/passphrase-cache", () => ({
  getSyncPassphrase: () => mockGetSyncPassphrase(),
  hasSyncPassphrase: () => mockHasSyncPassphrase(),
  loadPersistedSyncPassphrase: () => mockLoadPersistedSyncPassphrase(),
}))
jest.mock("@/lib/webdav/remote-newer-notify", () => ({
  notifyIfRemoteNewer: (input: unknown) => mockNotifyRemoteNewer(input),
}))

import {
  maybeUploadToWebDav,
  runScheduledBackupOnce,
  startBackupScheduler,
  writeEncryptedLocalBackup,
  type ScheduledBackupMessages,
} from "./backup-scheduler"

const messages: ScheduledBackupMessages = {
  missingDestination: "missing destination",
  autoKeyUnavailable: "missing auto key",
  syncPassphraseLocked: "sync locked",
  newerTitle: "newer",
  newerBody: "newer body",
}

const pkg = {
  manifest: {
    exportedAt: "2026-07-19T00:00:00.000Z",
    device: { id: "device-a", label: "Server A" },
  },
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({
    backupAutoSchedule: {
      enabled: true,
      intervalDays: 1,
      retainCount: 2,
      dirPath: "/srv/backups",
    },
    webdavSync: { enabled: false },
  })
  mockBuildPackage.mockResolvedValue(pkg)
  mockGetAutoKey.mockResolvedValue("auto-key")
  mockShouldRun.mockReturnValue(true)
  mockPrune.mockReturnValue([{ name: "/srv/backups/old.enc.cbk", completedAt: -2 }])
  mockEncrypt.mockResolvedValue("encrypted")
  mockHasSyncPassphrase.mockReturnValue(false)
  mockGetSyncPassphrase.mockReturnValue(null)
  mockLoadPersistedSyncPassphrase.mockResolvedValue(false)
  mockAttachPortableRetrievalKeys.mockClear()
})

it("streams encrypted scheduled backups without constructing a legacy package", async () => {
  const chunks = [
    new TextEncoder().encode(JSON.stringify({ manifest: { device: { id: "device-a" } } }) + "\n"),
    new TextEncoder().encode("encrypted-chunk\n"),
  ]
  mockBuildStream.mockImplementation(async function* () {
    yield* chunks
  })
  const filesystem = {
    writeTextFile: jest.fn(),
    readDirNames: jest.fn(async () => []),
    remove: jest.fn(),
    writeStream: jest.fn(async (_target: string, source: AsyncIterable<Uint8Array>) => {
      let size = 0
      for await (const chunk of source) size += chunk.byteLength
      return size
    }),
  }
  await expect(runScheduledBackupOnce({ filesystem, messages })).resolves.toBe(true)
  expect(mockBuildPackage).not.toHaveBeenCalled()
  expect(filesystem.writeTextFile).not.toHaveBeenCalled()
  expect(mockBuildStream).toHaveBeenCalledWith(
    { includeSessions: true, includeApiKey: false },
    { encryption: { passphrase: "auto-key" } }
  )
  expect(mockAppendHistory).toHaveBeenCalledWith(
    expect.objectContaining({
      success: true,
      deviceId: "device-a",
      sizeBytes: chunks.reduce((sum, value) => sum + value.byteLength, 0),
    })
  )
})

it("stops generating stream chunks when a scheduled task is cancelled", async () => {
  const controller = new AbortController()
  mockBuildStream.mockImplementation(async function* () {
    yield new TextEncoder().encode('{"manifest":{}}\n')
    controller.abort()
    yield new Uint8Array([1])
  })
  const chunks: Uint8Array[] = []
  await expect(
    writeEncryptedLocalBackup(
      {
        writeTextFile: jest.fn(),
        readDirNames: jest.fn(),
        remove: jest.fn(),
        writeStream: async (_path, source) => {
          for await (const chunk of source) chunks.push(chunk)
          return 1
        },
      },
      "target",
      { includeSessions: true, includeApiKey: false },
      "pass",
      controller.signal
    )
  ).rejects.toThrow()
  expect(chunks).toHaveLength(1)
})

it("retains a completed local stream when the remote package exceeds its size limit", async () => {
  mockPrune.mockReturnValue([])
  mockGetSettings.mockResolvedValue({
    backupAutoSchedule: { enabled: true, dirPath: "/srv/backups", retainCount: 2 },
    webdavSync: { enabled: true },
  })
  mockBuildStream.mockImplementation(async function* () {
    yield new TextEncoder().encode('{"manifest":{}}\n')
  })
  mockBuildPackage.mockRejectedValueOnce(new Error("backup_requires_streaming_export"))
  const filesystem = {
    writeTextFile: jest.fn(),
    readDirNames: jest.fn(async () => []),
    remove: jest.fn(),
    writeStream: async (_path: string, source: AsyncIterable<Uint8Array>) => {
      let size = 0
      for await (const chunk of source) size += chunk.byteLength
      return size
    },
  }
  await expect(runScheduledBackupOnce({ filesystem, messages })).resolves.toBe(true)
  expect(mockAppendHistory).toHaveBeenCalledWith(
    expect.objectContaining({ success: true, encryption: "auto-key" })
  )
  expect(mockAppendHistory).toHaveBeenCalledWith(
    expect.objectContaining({ success: false, errorMessage: "backup_requires_streaming_export" })
  )
  expect(mockUpload).not.toHaveBeenCalled()
  expect(filesystem.remove).not.toHaveBeenCalled()
})

afterEach(() => {
  jest.useRealTimers()
})

it("writes, prunes, records, and stamps one encrypted scheduled backup through the injected host filesystem", async () => {
  const filesystem = {
    writeTextFile: jest.fn(async () => undefined),
    readDirNames: jest.fn(async () => [
      "cognia-backup-2026-07-19.enc.cbk",
      "old.enc.cbk",
      "notes.txt",
    ]),
    remove: jest.fn(async () => undefined),
  }

  await expect(
    runScheduledBackupOnce({
      filesystem,
      messages,
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    })
  ).resolves.toBe(true)

  expect(filesystem.writeTextFile).toHaveBeenCalledWith(
    "/srv/backups/cognia-backup-2026-07-19.enc.cbk",
    "encrypted"
  )
  expect(filesystem.remove).toHaveBeenCalledWith("/srv/backups/old.enc.cbk")
  expect(mockAttachPortableRetrievalKeys).toHaveBeenCalledWith(pkg, "auto-key")
  expect(mockAppendHistory).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "scheduled",
      success: true,
      encryption: "auto-key",
      filename: "cognia-backup-2026-07-19.enc.cbk",
      deviceId: "device-a",
    })
  )
  expect(mockSaveSettings).toHaveBeenCalledWith({
    backupAutoSchedule: expect.objectContaining({ lastRunAt: expect.any(String) }),
  })
})

it("records a translated failure when the host has no writable destination", async () => {
  await expect(runScheduledBackupOnce({ filesystem: null, messages })).resolves.toBe(false)
  expect(mockBuildPackage).not.toHaveBeenCalled()
  expect(mockAppendHistory).toHaveBeenCalledWith(
    expect.objectContaining({ success: false, errorMessage: "missing destination" })
  )
})

it("does nothing while disabled or before the configured interval is due", async () => {
  mockGetSettings.mockResolvedValueOnce({ backupAutoSchedule: { enabled: false } })
  await expect(runScheduledBackupOnce({ filesystem: null, messages })).resolves.toBe(false)

  mockShouldRun.mockReturnValueOnce(false)
  await expect(runScheduledBackupOnce({ filesystem: null, messages })).resolves.toBe(false)
  expect(mockAppendHistory).not.toHaveBeenCalled()
})

it("passes only the latest scheduled completion to the due-date policy", async () => {
  mockShouldRun.mockReturnValue(false)
  mockGetLatestSuccessful.mockResolvedValueOnce({ type: "scheduled", completedAt: 123 })
  await runScheduledBackupOnce({ filesystem: null, messages })
  expect(mockShouldRun).toHaveBeenLastCalledWith(expect.objectContaining({ lastSuccessAt: 123 }))

  mockGetLatestSuccessful.mockResolvedValueOnce({ type: "manual", completedAt: 456 })
  await runScheduledBackupOnce({ filesystem: null, messages })
  expect(mockShouldRun).toHaveBeenLastCalledWith(
    expect.objectContaining({ lastSuccessAt: undefined })
  )
})

it("keeps a completed backup valid when retention cleanup and metadata stamping fail", async () => {
  const filesystem = {
    writeTextFile: jest.fn(async () => undefined),
    readDirNames: jest.fn(async () => ["old.enc.cbk"]),
    remove: jest.fn(async () => {
      throw new Error("retention denied")
    }),
  }
  mockSaveSettings.mockRejectedValueOnce(new Error("settings locked"))

  await expect(runScheduledBackupOnce({ filesystem, messages })).resolves.toBe(true)
  expect(mockAppendHistory).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
})

it("treats directory enumeration as best-effort and records write/key failures", async () => {
  const filesystem = {
    writeTextFile: jest.fn(async () => undefined),
    readDirNames: jest.fn(async () => {
      throw new Error("cannot enumerate")
    }),
    remove: jest.fn(async () => undefined),
  }
  await expect(runScheduledBackupOnce({ filesystem, messages })).resolves.toBe(true)

  mockGetAutoKey.mockResolvedValueOnce(null)
  await expect(runScheduledBackupOnce({ filesystem, messages })).resolves.toBe(false)
  expect(mockAppendHistory).toHaveBeenCalledWith(
    expect.objectContaining({ success: false, errorMessage: "missing auto key" })
  )

  mockBuildPackage.mockRejectedValueOnce("package failed")
  await expect(runScheduledBackupOnce({ filesystem, messages })).resolves.toBe(false)
  expect(mockAppendHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ success: false, errorMessage: "package failed" })
  )
})

it("normalizes Windows destinations and sorts multiple retention candidates", async () => {
  mockGetSettings.mockResolvedValueOnce({
    backupAutoSchedule: {
      enabled: true,
      intervalDays: 1,
      retainCount: 2,
      dirPath: "C:\\backups\\",
    },
    webdavSync: { enabled: false },
  })
  const filesystem = {
    writeTextFile: jest.fn(async () => undefined),
    readDirNames: jest.fn(async () => ["b.enc.cbk", "a.enc.cbk", "c.enc.cbk"]),
    remove: jest.fn(async () => undefined),
  }

  await runScheduledBackupOnce({ filesystem, messages })
  expect(filesystem.writeTextFile).toHaveBeenCalledWith(
    "C:\\backups\\cognia-backup-2026-07-19.enc.cbk",
    "encrypted"
  )
})

it("preserves every WebDAV outcome in backup history", async () => {
  await maybeUploadToWebDav(true, pkg as never, "plain", messages)
  expect(mockAppendHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ success: false, errorMessage: "sync locked" })
  )

  mockHasSyncPassphrase.mockReturnValue(true)
  mockGetSyncPassphrase.mockReturnValue("sync-passphrase")
  mockUpload.mockResolvedValueOnce({ ok: true })
  mockGetSettings.mockResolvedValueOnce({ webdavSync: { enabled: true } })
  await maybeUploadToWebDav(true, pkg as never, "plain", messages)
  expect(mockSaveSettings).toHaveBeenLastCalledWith({
    webdavSync: expect.objectContaining({ enabled: true, lastSyncAt: expect.any(String) }),
  })
  expect(mockAttachPortableRetrievalKeys).toHaveBeenLastCalledWith(pkg, "sync-passphrase")

  mockUpload.mockResolvedValueOnce({ ok: false, error: "remote unavailable" })
  await maybeUploadToWebDav(true, pkg as never, "plain", messages)
  expect(mockAppendHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ success: false, errorMessage: "remote unavailable" })
  )

  mockEncrypt.mockRejectedValueOnce("encryption failed")
  await maybeUploadToWebDav(true, pkg as never, "plain", messages)
  expect(mockAppendHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ success: false, errorMessage: "encryption failed" })
  )

  mockEncrypt.mockRejectedValueOnce(new Error("cipher unavailable"))
  await maybeUploadToWebDav(true, pkg as never, "plain", messages)
  expect(mockAppendHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ success: false, errorMessage: "cipher unavailable" })
  )
})

it("runs immediately, repeats on the configured interval, and tears down cleanly", async () => {
  jest.useFakeTimers()
  mockGetSettings.mockResolvedValue({ backupAutoSchedule: { enabled: false } })
  const log = jest.fn()
  const stop = startBackupScheduler({ filesystem: null, messages, intervalMs: 50, log })

  await jest.advanceTimersByTimeAsync(0)
  expect(mockLoadPersistedSyncPassphrase).toHaveBeenCalledTimes(1)

  await jest.advanceTimersByTimeAsync(50)
  expect(mockLoadPersistedSyncPassphrase).toHaveBeenCalledTimes(2)
  expect(mockNotifyRemoteNewer).toHaveBeenCalled()

  stop()
  expect(jest.getTimerCount()).toBe(0)

  mockLoadPersistedSyncPassphrase.mockRejectedValueOnce(new Error("keyring unavailable"))
  const stopAfterError = startBackupScheduler({ filesystem: null, messages, intervalMs: 50, log })
  await jest.advanceTimersByTimeAsync(0)
  expect(log).toHaveBeenCalledWith("warn", "keyring unavailable")
  stopAfterError()

  mockLoadPersistedSyncPassphrase.mockRejectedValueOnce("keyring locked")
  const stopAfterStringError = startBackupScheduler({ filesystem: null, messages, log })
  await jest.advanceTimersByTimeAsync(0)
  expect(log).toHaveBeenCalledWith("warn", "keyring locked")
  stopAfterStringError()
})
