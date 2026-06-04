// The remote-newer → notification-center bridge: posts a deduped "system"
// notification only on a fresh newer-snapshot result, routes the href per
// shell, and never throws.

jest.mock("./startup-check", () => ({
  checkRemoteNewerThanLocal: jest.fn(async () => null),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))

jest.mock("@/lib/notifications/runtime", () => ({
  notify: jest.fn(async () => "n-1"),
}))

import { checkRemoteNewerThanLocal } from "./startup-check"
import { isTauri } from "@/lib/tauri"
import { notify } from "@/lib/notifications/runtime"
import { notifyIfRemoteNewer, remoteNewerHref } from "./remote-newer-notify"

const mockCheck = checkRemoteNewerThanLocal as jest.Mock
const mockIsTauri = isTauri as jest.Mock
const mockNotify = notify as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockCheck.mockResolvedValue(null)
  mockIsTauri.mockReturnValue(false)
})

describe("remoteNewerHref", () => {
  it("routes to the settings data section on desktop, /me/backup elsewhere", () => {
    mockIsTauri.mockReturnValue(true)
    expect(remoteNewerHref()).toBe("/settings?section=data")
    mockIsTauri.mockReturnValue(false)
    expect(remoteNewerHref()).toBe("/me/backup")
  })
})

describe("notifyIfRemoteNewer", () => {
  it("posts a deduped system notification when the remote is newer", async () => {
    mockCheck.mockResolvedValue({ newer: true, remoteAt: 1_750_000_000_000 })
    const posted = await notifyIfRemoteNewer({ title: "Newer backup found", body: "Restore?" })
    expect(posted).toBe(true)
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "system",
        level: "info",
        title: "Newer backup found",
        body: "Restore?",
        href: "/me/backup",
        dedupeKey: "webdav-remote-newer:1750000000000",
        directed: true,
      })
    )
  })

  it("stays silent when the check returns null (unconfigured) or not newer", async () => {
    expect(await notifyIfRemoteNewer({ title: "t" })).toBe(false)
    mockCheck.mockResolvedValue({ newer: false, remoteAt: 1 })
    expect(await notifyIfRemoteNewer({ title: "t" })).toBe(false)
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it("never throws when the check or notify fails", async () => {
    mockCheck.mockRejectedValueOnce(new Error("network"))
    expect(await notifyIfRemoteNewer({ title: "t" })).toBe(false)

    mockCheck.mockResolvedValue({ newer: true, remoteAt: 2 })
    mockNotify.mockRejectedValueOnce(new Error("dexie"))
    expect(await notifyIfRemoteNewer({ title: "t" })).toBe(false)
  })
})
