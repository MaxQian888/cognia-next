const isTauriMock = jest.fn<boolean, []>(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const checkMock = jest.fn()
jest.mock("@tauri-apps/plugin-updater", () => ({ check: () => checkMock() }), { virtual: true })

const relaunchMock = jest.fn(async () => {})
jest.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunchMock() }), {
  virtual: true,
})

import { checkForUpdate, downloadAndInstallUpdate, __resetPendingUpdate } from "./updater"

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  __resetPendingUpdate()
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

  it("returns 'noLongerAvailable' when no handle is cached and a re-check finds nothing", async () => {
    checkMock.mockResolvedValueOnce(null)
    expect(await downloadAndInstallUpdate()).toBe("noLongerAvailable")
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it("downloads, installs and relaunches when an update is pending (no cache)", async () => {
    const downloadAndInstall = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({ version: "2.0.0", downloadAndInstall })
    expect(await downloadAndInstallUpdate()).toBe("installed")
    expect(downloadAndInstall).toHaveBeenCalled()
    expect(relaunchMock).toHaveBeenCalled()
  })

  it("reuses the handle cached by checkForUpdate without a second check()", async () => {
    const downloadAndInstall = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({ version: "2.0.0", body: "x", downloadAndInstall })
    await checkForUpdate()
    expect(checkMock).toHaveBeenCalledTimes(1)

    expect(await downloadAndInstallUpdate()).toBe("installed")
    // No second network round-trip: the cached handle was reused.
    expect(checkMock).toHaveBeenCalledTimes(1)
    expect(downloadAndInstall).toHaveBeenCalled()
    expect(relaunchMock).toHaveBeenCalled()
  })

  it("re-checks when the cached handle has aged past its TTL", async () => {
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000)
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      downloadAndInstall: jest.fn(async () => {}),
    })
    await checkForUpdate()
    expect(checkMock).toHaveBeenCalledTimes(1)

    // Jump past the 10-minute reuse window: the stale handle must be discarded.
    nowSpy.mockReturnValue(1_000 + 11 * 60 * 1000)
    const fresh = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({ version: "2.0.1", downloadAndInstall: fresh })
    expect(await downloadAndInstallUpdate()).toBe("installed")
    expect(checkMock).toHaveBeenCalledTimes(2)
    expect(fresh).toHaveBeenCalled()
    expect(relaunchMock).toHaveBeenCalled()
    nowSpy.mockRestore()
  })

  it("clears the cache after a current check so install re-checks", async () => {
    checkMock.mockResolvedValueOnce(null)
    await checkForUpdate()
    checkMock.mockResolvedValueOnce(null)
    expect(await downloadAndInstallUpdate()).toBe("noLongerAvailable")
    expect(checkMock).toHaveBeenCalledTimes(2)
  })

  it("streams normalized download progress to the callback", async () => {
    const downloadAndInstall = jest.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } })
      onEvent?.({ event: "Progress", data: { chunkLength: 40 } })
      onEvent?.({ event: "Progress", data: { chunkLength: 60 } })
      onEvent?.({ event: "Finished" })
    })
    checkMock.mockResolvedValueOnce({ version: "2.0.0", downloadAndInstall })
    const ticks: Array<{ downloaded: number; total?: number }> = []
    await downloadAndInstallUpdate((p) => ticks.push(p))
    expect(ticks).toEqual([
      { downloaded: 0, total: 100 },
      { downloaded: 40, total: 100 },
      { downloaded: 100, total: 100 },
      { downloaded: 100, total: 100 },
    ])
  })

  it("tolerates a missing content length (indeterminate progress)", async () => {
    const downloadAndInstall = jest.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: "Started", data: {} })
      onEvent?.({ event: "Progress", data: { chunkLength: 25 } })
      onEvent?.({ event: "Finished" })
    })
    checkMock.mockResolvedValueOnce({ version: "2.0.0", downloadAndInstall })
    const ticks: Array<{ downloaded: number; total?: number }> = []
    await downloadAndInstallUpdate((p) => ticks.push(p))
    expect(ticks).toEqual([
      { downloaded: 0, total: undefined },
      { downloaded: 25, total: undefined },
      { downloaded: 25, total: undefined },
    ])
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
