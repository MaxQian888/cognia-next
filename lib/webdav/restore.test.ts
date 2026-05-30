import type { WebDavEntry } from "./types"

interface FakeClient {
  getFile: jest.Mock
  propfindList: jest.Mock
}
let fakeClient: FakeClient | null = null

jest.mock("./config", () => ({
  makeWebDavClient: async () =>
    fakeClient ? { client: fakeClient, config: { remoteDir: "/cognia-backups" } } : null,
}))

const decryptMock = jest.fn(async (..._a: unknown[]) => '{"version":"3.0"}')
const migrateMock = jest.fn(async (..._a: unknown[]) => ({ manifest: {}, payload: {} }))
const isEncryptedMock = jest.fn((..._a: unknown[]) => true)
const applyMock = jest.fn(async (..._a: unknown[]) => ({ added: {}, overwritten: {}, skipped: {} }))
const setSyncPassphraseMock = jest.fn()

jest.mock("@/lib/data/crypto", () => ({
  decryptBackupPackage: (...a: unknown[]) => decryptMock(...a),
}))
jest.mock("@/lib/data/migrate", () => ({
  migrateEnvelope: (...a: unknown[]) => migrateMock(...a),
  isEncryptedEnvelope: (...a: unknown[]) => isEncryptedMock(...a),
}))
jest.mock("@/lib/data/apply-package", () => ({
  applyBackupPackage: (...a: unknown[]) => applyMock(...a),
}))
jest.mock("./passphrase-cache", () => ({
  setSyncPassphrase: (...a: unknown[]) => setSyncPassphraseMock(...a),
}))

import { listRemoteSnapshots, restoreFromWebDav } from "./restore"

function entry(name: string, lastModified?: number, isCollection = false): WebDavEntry {
  return { href: `/cognia-backups/${name}`, name, isCollection, lastModified }
}

beforeEach(() => {
  fakeClient = null
  decryptMock.mockClear()
  migrateMock.mockClear()
  isEncryptedMock.mockReturnValue(true)
  applyMock.mockClear()
  setSyncPassphraseMock.mockClear()
})

describe("listRemoteSnapshots", () => {
  it("returns [] when not configured", async () => {
    expect(await listRemoteSnapshots()).toEqual([])
  })

  it("filters to snapshots + latest, newest first, flags the pointer", async () => {
    fakeClient = {
      getFile: jest.fn(),
      propfindList: jest.fn(async () => [
        entry("cognia-backups", undefined, true),
        entry("latest.enc.cbk", 50),
        entry("cognia-backup-2026-05-30T01.enc.cbk", 10),
        entry("cognia-backup-2026-05-30T09.enc.cbk", 90),
        entry("unrelated.txt", 999),
      ]),
    }
    const snaps = await listRemoteSnapshots()
    expect(snaps.map((s) => s.name)).toEqual([
      "cognia-backup-2026-05-30T09.enc.cbk",
      "latest.enc.cbk",
      "cognia-backup-2026-05-30T01.enc.cbk",
    ])
    expect(snaps.find((s) => s.name === "latest.enc.cbk")?.isLatestPointer).toBe(true)
  })
})

describe("restoreFromWebDav", () => {
  it("throws when not configured", async () => {
    await expect(restoreFromWebDav({ passphrase: "p", mergeStrategy: "skip" })).rejects.toThrow(
      /not configured/i
    )
  })

  it("downloads the latest pointer by default, applies, and caches the passphrase", async () => {
    fakeClient = {
      getFile: jest.fn(async () => '{"version":"enc-v1"}'),
      propfindList: jest.fn(),
    }
    const summary = await restoreFromWebDav({ passphrase: "p", mergeStrategy: "overwrite" })
    expect(fakeClient.getFile).toHaveBeenCalledWith("/cognia-backups/latest.enc.cbk")
    expect(decryptMock).toHaveBeenCalled()
    expect(applyMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mergeStrategy: "overwrite", includeSessions: true })
    )
    expect(setSyncPassphraseMock).toHaveBeenCalledWith("p")
    expect(summary).toBeDefined()
  })

  it("rejects a non-encrypted remote file", async () => {
    isEncryptedMock.mockReturnValue(false)
    fakeClient = { getFile: jest.fn(async () => "{}"), propfindList: jest.fn() }
    await expect(restoreFromWebDav({ passphrase: "p", mergeStrategy: "skip" })).rejects.toThrow(
      /not an encrypted backup/i
    )
    expect(setSyncPassphraseMock).not.toHaveBeenCalled()
  })

  it("honors an explicit snapshot path", async () => {
    fakeClient = { getFile: jest.fn(async () => '{"version":"enc-v1"}'), propfindList: jest.fn() }
    await restoreFromWebDav({
      path: "/cognia-backups/cognia-backup-2026-05-30T01.enc.cbk",
      passphrase: "p",
      mergeStrategy: "skip",
    })
    expect(fakeClient.getFile).toHaveBeenCalledWith(
      "/cognia-backups/cognia-backup-2026-05-30T01.enc.cbk"
    )
  })
})
