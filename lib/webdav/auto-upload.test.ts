// Pure decision table for shouldAutoUpload + orchestration contract of
// maybeAutoUploadNow (hydrate → dirty check → shared sync-now pipeline with
// an "auto" history row; never throws).

import type { AppSettings } from "@cognia/agent-config-types"

let settings: Partial<AppSettings> = {}

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(async () => settings),
}))

jest.mock("@/lib/db/backup-history", () => ({
  getLatestSuccessful: jest.fn(async () => undefined),
}))

jest.mock("./passphrase-cache", () => ({
  hasSyncPassphrase: jest.fn(() => false),
  getSyncPassphrase: jest.fn(() => null),
  loadPersistedSyncPassphrase: jest.fn(async () => false),
}))

jest.mock("./sync-now", () => ({
  runWebDavSyncNow: jest.fn(async () => ({ ok: true })),
}))

import { getLatestSuccessful } from "@/lib/db/backup-history"
import {
  getSyncPassphrase,
  hasSyncPassphrase,
  loadPersistedSyncPassphrase,
} from "./passphrase-cache"
import { runWebDavSyncNow } from "./sync-now"
import { MIN_AUTO_SYNC_INTERVAL_MS, maybeAutoUploadNow, shouldAutoUpload } from "./auto-upload"

const mockHas = hasSyncPassphrase as jest.Mock
const mockGet = getSyncPassphrase as jest.Mock
const mockLoad = loadPersistedSyncPassphrase as jest.Mock
const mockRun = runWebDavSyncNow as jest.Mock
const mockLatest = getLatestSuccessful as jest.Mock

const NOW = 1_750_000_000_000

beforeEach(() => {
  jest.clearAllMocks()
  settings = {}
  mockHas.mockReturnValue(false)
  mockGet.mockReturnValue(null)
  mockLoad.mockResolvedValue(false)
  mockRun.mockResolvedValue({ ok: true })
  mockLatest.mockResolvedValue(undefined)
})

describe("shouldAutoUpload", () => {
  const base = {
    enabled: true,
    hasPassphrase: true,
    lastSyncAtMs: NOW - 2 * MIN_AUTO_SYNC_INTERVAL_MS,
    lastLocalChangeAtMs: NOW - MIN_AUTO_SYNC_INTERVAL_MS,
    nowMs: NOW,
  }

  it("uploads when enabled, unlocked, interval elapsed, and dirty", () => {
    expect(shouldAutoUpload(base)).toBe(true)
  })

  it("never uploads when disabled or locked", () => {
    expect(shouldAutoUpload({ ...base, enabled: false })).toBe(false)
    expect(shouldAutoUpload({ ...base, hasPassphrase: false })).toBe(false)
  })

  it("uploads immediately when never uploaded before", () => {
    expect(shouldAutoUpload({ ...base, lastSyncAtMs: null, lastLocalChangeAtMs: null })).toBe(true)
  })

  it("respects the minimum interval floor", () => {
    expect(
      shouldAutoUpload({
        ...base,
        lastSyncAtMs: NOW - MIN_AUTO_SYNC_INTERVAL_MS + 1000,
      })
    ).toBe(false)
  })

  it("honors a custom minIntervalMs", () => {
    expect(
      shouldAutoUpload({
        ...base,
        lastSyncAtMs: NOW - 10_000,
        lastLocalChangeAtMs: NOW - 1_000,
        minIntervalMs: 5_000,
      })
    ).toBe(true)
  })

  it("skips when nothing changed since the last upload", () => {
    expect(
      shouldAutoUpload({
        ...base,
        lastLocalChangeAtMs: base.lastSyncAtMs! - 1000,
      })
    ).toBe(false)
    expect(shouldAutoUpload({ ...base, lastLocalChangeAtMs: null })).toBe(false)
  })
})

describe("maybeAutoUploadNow", () => {
  it("returns disabled when webdav sync is off", async () => {
    settings = { webdavSync: { enabled: false } }
    expect(await maybeAutoUploadNow(NOW)).toEqual({ ran: false, reason: "disabled" })
    expect(mockLoad).not.toHaveBeenCalled()
  })

  it("attempts keyring hydration before reporting locked", async () => {
    settings = { webdavSync: { enabled: true } }
    expect(await maybeAutoUploadNow(NOW)).toEqual({ ran: false, reason: "locked" })
    expect(mockLoad).toHaveBeenCalledTimes(1)
  })

  it("uploads with an 'auto' history row when hydration unlocks the cache", async () => {
    settings = { webdavSync: { enabled: true }, updatedAt: NOW - 1000 }
    // First call (cache cold) → hydrate succeeds → second check warm.
    mockHas.mockReturnValueOnce(false).mockReturnValue(true)
    mockLoad.mockResolvedValue(true)
    mockGet.mockReturnValue("pass")

    const out = await maybeAutoUploadNow(NOW)
    expect(out).toEqual({ ran: true, ok: true })
    expect(mockRun).toHaveBeenCalledWith("pass", { historyType: "auto" })
  })

  it("skips as fresh when within the minimum interval", async () => {
    mockHas.mockReturnValue(true)
    mockGet.mockReturnValue("pass")
    settings = {
      webdavSync: { enabled: true, lastSyncAt: new Date(NOW - 60_000).toISOString() },
      updatedAt: NOW,
    }
    expect(await maybeAutoUploadNow(NOW)).toEqual({ ran: false, reason: "fresh" })
    expect(mockRun).not.toHaveBeenCalled()
  })

  it("skips as fresh when nothing changed since the last upload", async () => {
    mockHas.mockReturnValue(true)
    mockGet.mockReturnValue("pass")
    const lastSync = NOW - 2 * MIN_AUTO_SYNC_INTERVAL_MS
    settings = {
      webdavSync: { enabled: true, lastSyncAt: new Date(lastSync).toISOString() },
      updatedAt: lastSync - 5_000,
    }
    expect(await maybeAutoUploadNow(NOW)).toEqual({ ran: false, reason: "fresh" })
  })

  it("uses the newest backup-history success as a change signal", async () => {
    mockHas.mockReturnValue(true)
    mockGet.mockReturnValue("pass")
    const lastSync = NOW - 2 * MIN_AUTO_SYNC_INTERVAL_MS
    settings = {
      webdavSync: { enabled: true, lastSyncAt: new Date(lastSync).toISOString() },
      updatedAt: 0,
    }
    mockLatest.mockResolvedValue({ completedAt: lastSync + 60_000 })
    const out = await maybeAutoUploadNow(NOW)
    expect(out).toEqual({ ran: true, ok: true })
  })

  it("propagates upload failure without throwing", async () => {
    mockHas.mockReturnValue(true)
    mockGet.mockReturnValue("pass")
    mockRun.mockResolvedValue({ ok: false, error: "507 insufficient storage" })
    settings = { webdavSync: { enabled: true }, updatedAt: NOW }
    expect(await maybeAutoUploadNow(NOW)).toEqual({
      ran: true,
      ok: false,
      error: "507 insufficient storage",
    })
  })

  it("never throws when settings access fails", async () => {
    const { getSettings } = jest.requireMock("@/lib/db/settings") as { getSettings: jest.Mock }
    getSettings.mockRejectedValueOnce(new Error("dexie closed"))
    const out = await maybeAutoUploadNow(NOW)
    expect(out.ran).toBe(true)
    expect((out as { ok: boolean }).ok).toBe(false)
  })

  it("treats an unparseable lastSyncAt as never-uploaded", async () => {
    mockHas.mockReturnValue(true)
    mockGet.mockReturnValue("pass")
    settings = { webdavSync: { enabled: true, lastSyncAt: "not-a-date" } }
    const out = await maybeAutoUploadNow(NOW)
    expect(out).toEqual({ ran: true, ok: true })
  })

  it("stringifies non-Error throwables", async () => {
    mockHas.mockReturnValue(true)
    mockGet.mockReturnValue("pass")
    settings = { webdavSync: { enabled: true } }
    mockRun.mockRejectedValueOnce("plain string failure")
    const out = await maybeAutoUploadNow(NOW)
    expect(out).toEqual({ ran: true, ok: false, error: "plain string failure" })
  })
})
