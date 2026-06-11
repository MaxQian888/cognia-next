const isTauriMock = jest.fn<boolean, []>(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const checkMock = jest.fn()
jest.mock("@tauri-apps/plugin-updater", () => ({ check: () => checkMock() }), { virtual: true })

const relaunchMock = jest.fn(async () => {})
jest.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunchMock() }), {
  virtual: true,
})

import { checkForUpdate, downloadAndInstallUpdate } from "./updater"

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
})

describe("checkForUpdate", () => {
  it("returns null off the desktop shell without touching the plugin", async () => {
    isTauriMock.mockReturnValue(false)
    expect(await checkForUpdate()).toBeNull()
    expect(checkMock).not.toHaveBeenCalled()
  })

  it("returns null when already current", async () => {
    checkMock.mockResolvedValueOnce(null)
    expect(await checkForUpdate()).toBeNull()
  })

  it("maps an available update to version + notes", async () => {
    checkMock.mockResolvedValueOnce({
      version: "1.2.3",
      body: "Notes",
      downloadAndInstall: jest.fn(),
    })
    expect(await checkForUpdate()).toEqual({ version: "1.2.3", body: "Notes" })
  })

  it("propagates a check failure", async () => {
    checkMock.mockRejectedValueOnce(new Error("network"))
    await expect(checkForUpdate()).rejects.toThrow("network")
  })
})

describe("downloadAndInstallUpdate", () => {
  it("returns 'web' off the desktop shell", async () => {
    isTauriMock.mockReturnValue(false)
    expect(await downloadAndInstallUpdate()).toBe("web")
    expect(checkMock).not.toHaveBeenCalled()
  })

  it("returns 'noLongerAvailable' when the update vanished", async () => {
    checkMock.mockResolvedValueOnce(null)
    expect(await downloadAndInstallUpdate()).toBe("noLongerAvailable")
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it("downloads, installs and relaunches when an update is pending", async () => {
    const downloadAndInstall = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({ version: "2.0.0", downloadAndInstall })
    expect(await downloadAndInstallUpdate()).toBe("installed")
    expect(downloadAndInstall).toHaveBeenCalled()
    expect(relaunchMock).toHaveBeenCalled()
  })

  it("propagates an install failure before relaunch", async () => {
    const downloadAndInstall = jest.fn(async () => {
      throw new Error("disk full")
    })
    checkMock.mockResolvedValueOnce({ version: "2.0.0", downloadAndInstall })
    await expect(downloadAndInstallUpdate()).rejects.toThrow("disk full")
    expect(relaunchMock).not.toHaveBeenCalled()
  })
})
