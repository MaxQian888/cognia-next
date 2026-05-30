import type { WebDavEntry } from "@/lib/webdav/types"

interface FakeClient {
  ensureCollection: jest.Mock
  putFile: jest.Mock
  propfindList: jest.Mock
  deleteFile: jest.Mock
}

let fakeClient: FakeClient | null = null
let retainCount = 5

jest.mock("@/lib/webdav/config", () => ({
  makeWebDavClient: async () =>
    fakeClient ? { client: fakeClient, config: { remoteDir: "/cognia-backups" } } : null,
}))

jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => ({ backupAutoSchedule: { retainCount } }),
}))

jest.mock("@/lib/data/crypto", () => ({
  encryptBackupPackage: jest.fn(
    async (plaintext: string, passphrase: string, manifest: unknown) => ({
      plaintext,
      passphrase,
      manifest,
    })
  ),
}))

import type { BackupPackageV3 } from "@/lib/data/types"
import { encryptSnapshotBody, uploadSnapshotToWebDav, webdavSnapshotName } from "./webdav"

function makeClient(entries: WebDavEntry[] = []): FakeClient {
  return {
    ensureCollection: jest.fn(async () => {}),
    putFile: jest.fn(async () => {}),
    propfindList: jest.fn(async () => entries),
    deleteFile: jest.fn(async () => {}),
  }
}

function snapshotEntry(name: string, lastModified: number): WebDavEntry {
  return { href: `/cognia-backups/${name}`, name, isCollection: false, lastModified }
}

beforeEach(() => {
  fakeClient = null
  retainCount = 5
})

describe("webdavSnapshotName", () => {
  it("derives a filesystem-safe name from the ISO manifest time", () => {
    expect(webdavSnapshotName("2026-05-30T12:30:00.000Z")).toBe(
      "cognia-backup-2026-05-30T12-30-00-000Z.enc.cbk"
    )
  })
})

describe("encryptSnapshotBody", () => {
  const pkg = {
    manifest: {
      version: "3.0",
      schemaVersion: 1,
      traceId: "t",
      exportedAt: "2026-05-30T12:30:00.000Z",
      appVersion: "0.1.0",
      backend: "tauri-dexie",
    },
  } as unknown as BackupPackageV3

  it("encrypts under the passphrase and returns the JSON envelope with the manifest", async () => {
    const body = await encryptSnapshotBody("PLAIN", pkg, "secret")
    const parsed = JSON.parse(body)
    expect(parsed.plaintext).toBe("PLAIN")
    expect(parsed.passphrase).toBe("secret")
    expect(parsed.manifest).toMatchObject({
      version: "3.0",
      schemaVersion: 1,
      traceId: "t",
      backend: "tauri-dexie",
      encryption: { enabled: true, format: "encrypted-envelope-v1" },
    })
  })
})

describe("uploadSnapshotToWebDav", () => {
  const meta = { filename: "f.enc.cbk", exportedAt: "2026-05-30T12:30:00.000Z", sizeBytes: 4 }

  it("returns an error when not configured", async () => {
    const result = await uploadSnapshotToWebDav("body", meta)
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/not configured/i) })
  })

  it("ensures the collection and PUTs both the snapshot and the latest pointer", async () => {
    fakeClient = makeClient()
    const result = await uploadSnapshotToWebDav("body", meta)
    expect(result.ok).toBe(true)
    expect(fakeClient.ensureCollection).toHaveBeenCalledWith("/cognia-backups")
    const putPaths = fakeClient.putFile.mock.calls.map((c) => c[0])
    expect(putPaths).toContain("/cognia-backups/cognia-backup-2026-05-30T12-30-00-000Z.enc.cbk")
    expect(putPaths).toContain("/cognia-backups/latest.enc.cbk")
  })

  it("prunes timestamped snapshots beyond retainCount, never the latest pointer", async () => {
    retainCount = 2
    fakeClient = makeClient([
      { href: "/cognia-backups/", name: "cognia-backups", isCollection: true },
      snapshotEntry("latest.enc.cbk", 100),
      snapshotEntry("cognia-backup-2026-05-30T03.enc.cbk", 30),
      snapshotEntry("cognia-backup-2026-05-30T02.enc.cbk", 20),
      snapshotEntry("cognia-backup-2026-05-30T01.enc.cbk", 10),
    ])
    await uploadSnapshotToWebDav("body", meta)
    const deleted = fakeClient.deleteFile.mock.calls.map((c) => c[0])
    // Keeps the 2 newest timestamped; deletes only the oldest. latest untouched.
    expect(deleted).toEqual(["/cognia-backups/cognia-backup-2026-05-30T01.enc.cbk"])
    expect(deleted).not.toContain("/cognia-backups/latest.enc.cbk")
  })

  it("reports an error string when a PUT throws", async () => {
    fakeClient = makeClient()
    fakeClient.putFile.mockRejectedValueOnce(new Error("507 insufficient storage"))
    const result = await uploadSnapshotToWebDav("body", meta)
    expect(result).toEqual({ ok: false, error: "507 insufficient storage" })
  })
})
