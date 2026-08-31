let settings: Record<string, unknown> = {}
const saveSettingsMock = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => settings,
  saveSettings: (...a: unknown[]) => saveSettingsMock(...a),
}))

const appendBackupHistoryMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/backup-history", () => ({
  appendBackupHistory: (...a: unknown[]) => appendBackupHistoryMock(...a),
}))

jest.mock("@/lib/device/device-identity", () => ({
  getDeviceMetadata: async () => ({ id: "dev-1", label: "Windows desktop", platform: "windows" }),
}))

const snapshotVaultsMock = jest.fn()
const applyVaultsMock = jest.fn()
jest.mock("@/lib/subscription/core/vault-snapshot", () => ({
  snapshotVaults: (...a: unknown[]) => snapshotVaultsMock(...a),
  applyVaults: (...a: unknown[]) => applyVaultsMock(...a),
}))

const clientMock = {
  ensureCollection: jest.fn().mockResolvedValue(undefined),
  putFile: jest.fn().mockResolvedValue(undefined),
  getFile: jest.fn(),
  propfindList: jest.fn().mockResolvedValue([]),
  deleteFile: jest.fn().mockResolvedValue(undefined),
}
const makeWebDavClientMock = jest.fn()
jest.mock("@/lib/webdav/config", () => ({
  makeWebDavClient: (...a: unknown[]) => makeWebDavClientMock(...a),
}))

const changeTracker = { lastChange: null as number | null }
jest.mock("./change-tracker", () => ({
  getLastVaultChangeAtMs: () => changeTracker.lastChange,
}))

import {
  encryptSubscriptionPackage,
  decryptSubscriptionPackage,
} from "@/lib/subscription/core/encrypted-package"
import { clearSubscriptionSyncPassphrase, setSubscriptionSyncPassphrase } from "./passphrase-cache"
import {
  MIN_SUBSCRIPTION_AUTO_SYNC_INTERVAL_MS,
  SUBSCRIPTION_LATEST_POINTER,
  applySubscriptionRestore,
  maybeAutoUploadSubscription,
  restoreSubscriptionFromWebDav,
  runSubscriptionSyncNow,
  subscriptionSnapshotName,
} from "./subscription-sync"

beforeEach(() => {
  jest.clearAllMocks()
  settings = {}
  changeTracker.lastChange = null
  snapshotVaultsMock.mockResolvedValue({})
  applyVaultsMock.mockResolvedValue({ accountCount: 0 })
  makeWebDavClientMock.mockResolvedValue({
    client: clientMock,
    config: { remoteDir: "/cognia-backups", baseUrl: "https://dav.example", username: "u" },
  })
  clientMock.putFile.mockResolvedValue(undefined)
  clientMock.propfindList.mockResolvedValue([])
})

afterEach(() => {
  clearSubscriptionSyncPassphrase()
})

describe("subscriptionSnapshotName", () => {
  it("derives a stamped filename", () => {
    expect(subscriptionSnapshotName("2026-06-07T12:30:00.000Z")).toBe(
      "cognia-subscription-2026-06-07T12-30-00-000Z.cogniabak.json"
    )
  })
})

describe("runSubscriptionSyncNow", () => {
  it("rejects when no passphrase is available", async () => {
    const got = await runSubscriptionSyncNow("")
    expect(got).toEqual({ ok: false, error: expect.stringContaining("passphrase") })
  })

  it("rejects when the WebDAV connection is unconfigured", async () => {
    makeWebDavClientMock.mockResolvedValue(null)
    const got = await runSubscriptionSyncNow("pw")
    expect(got.ok).toBe(false)
    // requireEnabled false — the subscription toggle is independent of the
    // data-sync toggle.
    expect(makeWebDavClientMock).toHaveBeenCalledWith({ requireEnabled: false })
  })

  it("uploads the stamped snapshot + latest pointer and records history", async () => {
    const phases: string[] = []
    const got = await runSubscriptionSyncNow("pw", { onProgress: (p) => phases.push(p) })
    expect(got).toEqual({ ok: true })
    expect(clientMock.ensureCollection).toHaveBeenCalledWith("/cognia-backups")
    const paths = clientMock.putFile.mock.calls.map((c: string[]) => c[0])
    expect(paths.some((p: string) => /cognia-subscription-.*\.cogniabak\.json$/.test(p))).toBe(true)
    expect(paths).toContain(`/cognia-backups/${SUBSCRIPTION_LATEST_POINTER}`)
    expect(appendBackupHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        payloadKind: "subscription",
        encryption: "passphrase",
        deviceId: "dev-1",
        deviceLabel: "Windows desktop",
      })
    )
    expect(saveSettingsMock).toHaveBeenCalledWith({
      webdavSync: expect.objectContaining({ subscriptionLastSyncAt: expect.any(String) }),
    })
    expect(phases).toEqual(["building", "encrypting", "uploading", "done"])
  })

  it("the uploaded envelope round-trips with the passphrase", async () => {
    await runSubscriptionSyncNow("pw")
    const json = clientMock.putFile.mock.calls[0][1] as string
    const body = await decryptSubscriptionPackage(JSON.parse(json), "pw")
    expect(body.manifest.version).toBe("subscription-v1")
    expect(body.manifest.device).toEqual(
      expect.objectContaining({ id: "dev-1", label: "Windows desktop" })
    )
  })

  it("records a failed history row when the upload throws", async () => {
    clientMock.putFile.mockRejectedValue(new Error("507 insufficient storage"))
    const got = await runSubscriptionSyncNow("pw")
    expect(got.ok).toBe(false)
    expect(appendBackupHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        payloadKind: "subscription",
        errorMessage: expect.stringContaining("507"),
      })
    )
  })

  it("prunes stale snapshots beyond the retain count", async () => {
    settings = { backupAutoSchedule: { retainCount: 1 } }
    clientMock.propfindList.mockResolvedValue([
      {
        name: "cognia-subscription-2026-01-01T00-00-00-000Z.cogniabak.json",
        isCollection: false,
        lastModified: 1,
      },
      {
        name: "cognia-subscription-2026-01-02T00-00-00-000Z.cogniabak.json",
        isCollection: false,
        lastModified: 2,
      },
      { name: SUBSCRIPTION_LATEST_POINTER, isCollection: false, lastModified: 3 },
      {
        name: "cognia-backup-2026-01-01T00-00-00-000Z.enc.cbk",
        isCollection: false,
        lastModified: 4,
      },
    ])
    await runSubscriptionSyncNow("pw")
    expect(clientMock.deleteFile).toHaveBeenCalledTimes(1)
    expect(clientMock.deleteFile).toHaveBeenCalledWith(
      "/cognia-backups/cognia-subscription-2026-01-01T00-00-00-000Z.cogniabak.json"
    )
  })

  it("falls back to the cached session passphrase", async () => {
    setSubscriptionSyncPassphrase("cached-pw")
    const got = await runSubscriptionSyncNow("")
    expect(got).toEqual({ ok: true })
  })
})

describe("maybeAutoUploadSubscription", () => {
  it("is disabled without the toggle", async () => {
    expect(await maybeAutoUploadSubscription()).toEqual({ ran: false, reason: "disabled" })
  })

  it("is locked without a passphrase", async () => {
    settings = { webdavSync: { subscriptionSyncEnabled: true } }
    expect(await maybeAutoUploadSubscription()).toEqual({ ran: false, reason: "locked" })
  })

  it("uploads on the first run (never uploaded)", async () => {
    settings = { webdavSync: { subscriptionSyncEnabled: true } }
    setSubscriptionSyncPassphrase("pw")
    expect(await maybeAutoUploadSubscription()).toEqual({ ran: true, ok: true })
  })

  it("is fresh within the minimum interval", async () => {
    const now = Date.now()
    settings = {
      webdavSync: {
        subscriptionSyncEnabled: true,
        subscriptionLastSyncAt: new Date(now - 1000).toISOString(),
      },
    }
    setSubscriptionSyncPassphrase("pw")
    changeTracker.lastChange = now
    expect(await maybeAutoUploadSubscription(now)).toEqual({ ran: false, reason: "fresh" })
  })

  it("is fresh when nothing changed since the last upload", async () => {
    const now = Date.now()
    settings = {
      webdavSync: {
        subscriptionSyncEnabled: true,
        subscriptionLastSyncAt: new Date(
          now - MIN_SUBSCRIPTION_AUTO_SYNC_INTERVAL_MS - 1000
        ).toISOString(),
      },
    }
    setSubscriptionSyncPassphrase("pw")
    changeTracker.lastChange = null
    expect(await maybeAutoUploadSubscription(now)).toEqual({ ran: false, reason: "fresh" })
  })

  it("uploads when a vault change postdates the last upload", async () => {
    const now = Date.now()
    const lastSync = now - MIN_SUBSCRIPTION_AUTO_SYNC_INTERVAL_MS - 1000
    settings = {
      webdavSync: {
        subscriptionSyncEnabled: true,
        subscriptionLastSyncAt: new Date(lastSync).toISOString(),
      },
    }
    setSubscriptionSyncPassphrase("pw")
    changeTracker.lastChange = lastSync + 500
    expect(await maybeAutoUploadSubscription(now)).toEqual({ ran: true, ok: true })
  })
})

describe("restoreSubscriptionFromWebDav", () => {
  it("downloads, decrypts and previews without applying", async () => {
    const envelope = await encryptSubscriptionPackage(
      {
        manifest: {
          version: "subscription-v1",
          createdAtIso: "2026-06-07T00:00:00.000Z",
          providers: ["opencode"],
          accountCount: { anthropic: 0, codex: 0, opencode: 1 },
        },
        vaults: { opencode: { schemaVersion: 4, accounts: [], presets: [] } },
      },
      "pw"
    )
    clientMock.getFile.mockResolvedValue(JSON.stringify(envelope))
    const preview = await restoreSubscriptionFromWebDav("pw")
    expect(clientMock.getFile).toHaveBeenCalledWith(
      `/cognia-backups/${SUBSCRIPTION_LATEST_POINTER}`
    )
    expect(preview.body.manifest.providers).toEqual(["opencode"])
    expect(applyVaultsMock).not.toHaveBeenCalled()

    applyVaultsMock.mockResolvedValue({ accountCount: 3 })
    expect(await applySubscriptionRestore(preview)).toEqual({ accountCount: 3 })
    expect(applyVaultsMock).toHaveBeenCalledWith(preview.body.vaults)
  })

  it("throws on a wrong passphrase", async () => {
    const envelope = await encryptSubscriptionPackage(
      {
        manifest: {
          version: "subscription-v1",
          createdAtIso: "2026-06-07T00:00:00.000Z",
          providers: [],
          accountCount: { anthropic: 0, codex: 0, opencode: 0 },
        },
        vaults: {},
      },
      "right"
    )
    clientMock.getFile.mockResolvedValue(JSON.stringify(envelope))
    await expect(restoreSubscriptionFromWebDav("wrong")).rejects.toThrow()
  })

  it("requires a passphrase and a configured connection", async () => {
    await expect(restoreSubscriptionFromWebDav("")).rejects.toThrow(/passphrase/)
    makeWebDavClientMock.mockResolvedValue(null)
    await expect(restoreSubscriptionFromWebDav("pw")).rejects.toThrow(/not configured/)
  })
})
