/** @jest-environment jsdom */
import type { AppSettings } from "@cognia/agent-config-types"

const settingsState: { current: Partial<AppSettings> } = { current: {} }
jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => settingsState.current,
  saveSettings: async (patch: Partial<AppSettings>) => {
    settingsState.current = { ...settingsState.current, ...patch }
    return settingsState.current
  },
}))
jest.mock("@cognia/logging", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { export: stub }, createLogger: () => stub }
})

import { __setBackupDestinationSecretStoreForTesting, saveGoogleDriveTokens } from "./config"
import { ensureGoogleDriveFolder, uploadSnapshotToGoogleDrive } from "./google-drive"
import type { BackupHttpFn, BackupHttpRequest } from "./http"

class MemoryStore {
  data = new Map<string, string>()
  async save(k: string, v: string) {
    this.data.set(k, v)
  }
  async load(k: string) {
    return this.data.get(k) ?? null
  }
  async delete(k: string) {
    this.data.delete(k)
  }
}

const meta = { filename: "f", exportedAt: "2026-08-16T02:00:00.000Z", sizeBytes: 3 }
const config = { clientId: "cid", folderName: "Cognia Backups" }

interface DriveState {
  folderExists?: boolean
  folderIdValid?: boolean
  latestId?: string
  files?: Array<{ id: string; name: string }>
  failCreate?: boolean
}

/** Scripted Drive API answering by URL shape. */
function makeDrive(state: DriveState = {}) {
  const calls: BackupHttpRequest[] = []
  const http: BackupHttpFn = async (request) => {
    calls.push(request)
    const url = new URL(request.url)
    const q = url.searchParams.get("q") ?? ""
    if (request.method === "GET" && url.pathname === "/drive/v3/files/folder-remembered") {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ id: "folder-remembered", trashed: !state.folderIdValid }),
      }
    }
    if (request.method === "GET" && url.pathname === "/drive/v3/files") {
      if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            files: state.folderExists ? [{ id: "folder-1", name: "Cognia Backups" }] : [],
          }),
        }
      }
      if (q.includes("name = 'latest.enc.cbk'")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            files: state.latestId ? [{ id: state.latestId, name: "latest.enc.cbk" }] : [],
          }),
        }
      }
      if (q.includes("name contains 'cognia-backup-'")) {
        return { status: 200, headers: {}, body: JSON.stringify({ files: state.files ?? [] }) }
      }
    }
    if (request.method === "POST" && url.pathname === "/drive/v3/files") {
      return state.failCreate
        ? { status: 403, headers: {}, body: JSON.stringify({ error: { message: "quota" } }) }
        : { status: 200, headers: {}, body: JSON.stringify({ id: "folder-new" }) }
    }
    if (request.method === "POST" && url.pathname === "/upload/drive/v3/files") {
      return { status: 200, headers: {}, body: JSON.stringify({ id: `file-${calls.length}` }) }
    }
    if (request.method === "PATCH" && url.pathname.startsWith("/upload/drive/v3/files/")) {
      return { status: 200, headers: {}, body: JSON.stringify({ id: "latest" }) }
    }
    if (request.method === "DELETE") return { status: 204, headers: {}, body: "" }
    return { status: 500, headers: {}, body: JSON.stringify({ error: { message: "unexpected" } }) }
  }
  return { http, calls }
}

beforeEach(async () => {
  __setBackupDestinationSecretStoreForTesting(new MemoryStore())
  settingsState.current = {
    backupAutoSchedule: { enabled: false, intervalDays: 7, retainCount: 1 },
    backupDestinations: { googleDrive: { enabled: true, clientId: "cid" } },
  }
  await saveGoogleDriveTokens({
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
  })
})
afterAll(() => __setBackupDestinationSecretStoreForTesting(null))

describe("ensureGoogleDriveFolder", () => {
  it("reuses a valid remembered folder id, else finds by name, else creates", async () => {
    const remembered = makeDrive({ folderIdValid: true })
    expect(
      await ensureGoogleDriveFolder(
        { ...config, folderId: "folder-remembered" },
        "at",
        remembered.http
      )
    ).toBe("folder-remembered")
    const trashed = makeDrive({ folderIdValid: false, folderExists: true })
    expect(
      await ensureGoogleDriveFolder(
        { ...config, folderId: "folder-remembered" },
        "at",
        trashed.http
      )
    ).toBe("folder-1")
    const created = makeDrive({ folderExists: false })
    expect(await ensureGoogleDriveFolder(config, "at", created.http)).toBe("folder-new")
    expect(settingsState.current.backupDestinations?.googleDrive?.folderId).toBe("folder-new")
    await expect(
      ensureGoogleDriveFolder(config, "at", makeDrive({ failCreate: true }).http)
    ).rejects.toThrow("quota")
  })
})

describe("uploadSnapshotToGoogleDrive", () => {
  it("refuses when not configured / not connected", async () => {
    settingsState.current = { backupDestinations: {} }
    expect(await uploadSnapshotToGoogleDrive("b", meta, { http: makeDrive().http })).toMatchObject({
      code: "not-configured",
    })
    settingsState.current = {
      backupDestinations: { googleDrive: { enabled: true, clientId: "cid" } },
    }
    __setBackupDestinationSecretStoreForTesting(new MemoryStore())
    expect(await uploadSnapshotToGoogleDrive("b", meta, { http: makeDrive().http })).toMatchObject({
      code: "not-connected",
    })
  })

  it("creates the snapshot, updates the latest pointer, prunes and stamps lastSyncAt", async () => {
    const drive = makeDrive({
      folderExists: true,
      latestId: "latest-1",
      files: [
        { id: "old", name: "cognia-backup-2026-08-01T00-00-00-000Z.enc.cbk" },
        { id: "new", name: "cognia-backup-2026-08-16T02-00-00-000Z.enc.cbk" },
        { id: "latest-1", name: "latest.enc.cbk" },
      ],
    })
    const result = await uploadSnapshotToGoogleDrive("body", meta, {
      http: drive.http,
      config,
      accessToken: "at",
      now: () => Date.UTC(2026, 7, 16, 2, 0, 5),
    })
    expect(result).toMatchObject({
      ok: true,
      remotePath: "Cognia Backups/cognia-backup-2026-08-16T02-00-00-000Z.enc.cbk",
    })
    const upload = drive.calls.find((c) => c.method === "POST" && c.url.includes("/upload/"))!
    expect(upload.headers?.["Content-Type"]).toMatch(/multipart\/related/)
    expect(upload.body).toContain('"parents":["folder-1"]')
    expect(upload.body).toContain("body")
    expect(drive.calls.some((c) => c.method === "PATCH" && c.url.includes("/latest-1?"))).toBe(true)
    // retainCount 1 → the older timestamped snapshot is deleted; latest is untouched.
    const deletes = drive.calls
      .filter((c) => c.method === "DELETE")
      .map((c) => new URL(c.url).pathname)
    expect(deletes).toEqual(["/drive/v3/files/old"])
    expect(settingsState.current.backupDestinations?.googleDrive?.lastSyncAt).toBe(
      "2026-08-16T02:00:05.000Z"
    )
  })

  it("creates the latest pointer when it does not exist yet", async () => {
    const drive = makeDrive({ folderExists: true })
    const result = await uploadSnapshotToGoogleDrive("body", meta, {
      http: drive.http,
      config,
      accessToken: "at",
    })
    expect(result.ok).toBe(true)
    expect(
      drive.calls.filter((c) => c.method === "POST" && c.url.includes("/upload/"))
    ).toHaveLength(2)
  })

  it("surfaces upload failures and refresh failures", async () => {
    const failing: BackupHttpFn = async (request) => {
      if (request.url.includes("/upload/"))
        return { status: 500, headers: {}, body: JSON.stringify({ error: { message: "boom" } }) }
      return makeDrive({ folderExists: true }).http(request)
    }
    expect(
      await uploadSnapshotToGoogleDrive("b", meta, { http: failing, config, accessToken: "at" })
    ).toEqual({
      ok: false,
      code: "http",
      error: "boom",
    })
    await saveGoogleDriveTokens({ accessToken: "stale", refreshToken: "rt", expiresAt: 1 })
    const refreshFails: BackupHttpFn = async () => ({
      status: 400,
      headers: {},
      body: JSON.stringify({ error: "invalid_grant" }),
    })
    expect(
      await uploadSnapshotToGoogleDrive("b", meta, { http: refreshFails, config, now: () => 5 })
    ).toMatchObject({
      ok: false,
      code: "not-connected",
    })
  })
})
