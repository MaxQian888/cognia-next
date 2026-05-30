interface FakeClient {
  lastModified: jest.Mock
}
let fakeClient: FakeClient | null = null
let madeThrows = false

jest.mock("./config", () => ({
  makeWebDavClient: async () => {
    if (madeThrows) throw new Error("transport unavailable")
    return fakeClient ? { client: fakeClient, config: { remoteDir: "/cognia-backups" } } : null
  },
}))

let settings: { webdavSync?: Record<string, unknown> } = {}
const saveSettingsMock = jest.fn(async (..._a: unknown[]) => {})
let latestLocal: { completedAt: number } | undefined

jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => settings,
  saveSettings: (...a: unknown[]) => saveSettingsMock(...a),
}))
jest.mock("@/lib/db/backup-history", () => ({
  getLatestSuccessful: async () => latestLocal,
}))

import { checkRemoteNewerThanLocal } from "./startup-check"

beforeEach(() => {
  fakeClient = null
  madeThrows = false
  settings = {}
  latestLocal = undefined
  saveSettingsMock.mockClear()
})

describe("checkRemoteNewerThanLocal", () => {
  it("returns null when not configured", async () => {
    expect(await checkRemoteNewerThanLocal()).toBeNull()
  })

  it("returns null when the transport throws (e.g. web)", async () => {
    madeThrows = true
    expect(await checkRemoteNewerThanLocal()).toBeNull()
  })

  it("not newer when there is no remote snapshot", async () => {
    fakeClient = { lastModified: jest.fn(async () => null) }
    expect(await checkRemoteNewerThanLocal()).toEqual({ newer: false })
  })

  it("newer when remote postdates local + stamps lastRemoteSeenAt", async () => {
    fakeClient = { lastModified: jest.fn(async () => 5000) }
    latestLocal = { completedAt: 1000 }
    const result = await checkRemoteNewerThanLocal()
    expect(result).toEqual({ newer: true, remoteAt: 5000 })
    expect(saveSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        webdavSync: expect.objectContaining({ lastRemoteSeenAt: new Date(5000).toISOString() }),
      })
    )
  })

  it("not newer when local is more recent", async () => {
    fakeClient = { lastModified: jest.fn(async () => 1000) }
    latestLocal = { completedAt: 9000 }
    const result = await checkRemoteNewerThanLocal()
    expect(result?.newer).toBe(false)
    expect(saveSettingsMock).not.toHaveBeenCalled()
  })

  it("dedupes: does not re-prompt for an already-seen remote snapshot", async () => {
    fakeClient = { lastModified: jest.fn(async () => 5000) }
    settings = { webdavSync: { lastRemoteSeenAt: new Date(5000).toISOString() } }
    const result = await checkRemoteNewerThanLocal()
    expect(result).toEqual({ newer: false, remoteAt: 5000 })
    expect(saveSettingsMock).not.toHaveBeenCalled()
  })
})
