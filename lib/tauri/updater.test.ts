const isTauriMock = jest.fn<boolean, []>(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const checkMock = jest.fn()
jest.mock(
  "@tauri-apps/plugin-updater",
  () => ({ check: (...args: unknown[]) => checkMock(...args) }),
  {
    virtual: true,
  }
)

const getActiveProxyUrlMock = jest.fn<string | null, []>(() => null)
jest.mock("@/stores/network-proxy", () => ({
  getActiveProxyUrl: () => getActiveProxyUrlMock(),
}))

const settingsState = {
  settings: {
    updates: {
      autoCheck: true,
      checkIntervalMinutes: 360,
      autoDownload: false,
      relaunchAfterInstall: true,
      requestTimeoutSeconds: 30,
      useProxy: true,
    },
  },
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => settingsState },
}))

const relaunchMock = jest.fn(async () => {})
jest.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunchMock() }), {
  virtual: true,
})

import {
  checkForUpdate,
  downloadAndInstallUpdate,
  downloadUpdate,
  installUpdate,
  relaunchAfterUpdate,
  resolveUpdateSettings,
  __resetPendingUpdate,
} from "./updater"

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  getActiveProxyUrlMock.mockReturnValue(null)
  settingsState.settings.updates = {
    autoCheck: true,
    checkIntervalMinutes: 360,
    autoDownload: false,
    relaunchAfterInstall: true,
    requestTimeoutSeconds: 30,
    useProxy: true,
  }
  __resetPendingUpdate()
})

async function waitForMockCall(mock: jest.Mock): Promise<void> {
  for (let attempt = 0; attempt < 10 && mock.mock.calls.length === 0; attempt += 1) {
    await Promise.resolve()
  }
  expect(mock).toHaveBeenCalled()
}

describe("resolveUpdateSettings", () => {
  it("merges defaults for an older settings row", () => {
    expect(resolveUpdateSettings({ autoCheck: false })).toEqual({
      autoCheck: false,
      checkIntervalMinutes: 360,
      autoDownload: false,
      relaunchAfterInstall: true,
      requestTimeoutSeconds: 30,
      useProxy: true,
    })
  })

  it("clamps invalid numeric preferences", () => {
    expect(
      resolveUpdateSettings({
        checkIntervalMinutes: 1,
        requestTimeoutSeconds: 999,
      })
    ).toEqual(expect.objectContaining({ checkIntervalMinutes: 15, requestTimeoutSeconds: 300 }))
    expect(
      resolveUpdateSettings({
        checkIntervalMinutes: Number.NaN,
        requestTimeoutSeconds: Number.POSITIVE_INFINITY,
      })
    ).toEqual(expect.objectContaining({ checkIntervalMinutes: 360, requestTimeoutSeconds: 30 }))
  })
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
      date: "2026-07-18T00:00:00Z",
      downloadAndInstall: jest.fn(),
    })
    expect(await checkForUpdate()).toEqual({
      version: "1.2.3",
      body: "Notes",
      date: "2026-07-18T00:00:00Z",
    })
  })

  it("passes the configured timeout and active proxy to the updater fetch", async () => {
    settingsState.settings.updates.requestTimeoutSeconds = 45
    getActiveProxyUrlMock.mockReturnValue("http://127.0.0.1:7890")
    checkMock.mockResolvedValueOnce(null)

    await checkForUpdate()

    expect(checkMock).toHaveBeenCalledWith({
      timeout: 45_000,
      proxy: "http://127.0.0.1:7890",
    })
  })

  it("omits the proxy when updater proxy use is disabled", async () => {
    settingsState.settings.updates.useProxy = false
    getActiveProxyUrlMock.mockReturnValue("http://127.0.0.1:7890")
    checkMock.mockResolvedValueOnce(null)

    await checkForUpdate()

    expect(checkMock).toHaveBeenCalledWith({ timeout: 30_000 })
  })

  it("falls back to a direct request when the proxy snapshot is unavailable", async () => {
    getActiveProxyUrlMock.mockImplementationOnce(() => {
      throw new Error("settings hydrating")
    })
    checkMock.mockResolvedValueOnce(null)

    await checkForUpdate()

    expect(checkMock).toHaveBeenCalledWith({ timeout: 30_000 })
  })

  it("deduplicates concurrent checks", async () => {
    let resolveCheck!: (value: null) => void
    checkMock.mockReturnValueOnce(new Promise<null>((resolve) => (resolveCheck = resolve)))

    const first = checkForUpdate()
    const second = checkForUpdate()
    await waitForMockCall(checkMock)
    expect(checkMock).toHaveBeenCalledTimes(1)
    resolveCheck(null)

    await expect(Promise.all([first, second])).resolves.toEqual([null, null])
  })

  it("closes a superseded native update handle", async () => {
    const close = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({
      version: "1.2.3",
      download: jest.fn(),
      install: jest.fn(),
      close,
    })
    await checkForUpdate()
    checkMock.mockResolvedValueOnce(null)

    await checkForUpdate()

    expect(close).toHaveBeenCalledTimes(1)
  })

  it("does not fail a successful check when native resource cleanup fails", async () => {
    checkMock.mockResolvedValueOnce({
      version: "1.2.3",
      download: jest.fn(),
      install: jest.fn(),
      close: jest.fn(async () => {
        throw new Error("already closed")
      }),
    })
    await checkForUpdate()
    checkMock.mockResolvedValueOnce(null)
    await expect(checkForUpdate()).resolves.toBeNull()
  })

  it("propagates a check failure", async () => {
    checkMock.mockRejectedValueOnce(new Error("network"))
    await expect(checkForUpdate()).rejects.toMatchObject({
      name: "AppUpdateError",
      code: "network",
      phase: "check",
      message: "network",
    })
  })

  it("classifies a denied Tauri capability as a permission error", async () => {
    checkMock.mockRejectedValueOnce(new Error("updater.check not allowed by ACL"))
    await expect(checkForUpdate()).rejects.toEqual(
      expect.objectContaining({ code: "permission", phase: "check" })
    )
  })

  it.each([
    ["request timed out", "timeout"],
    ["invalid minisign signature", "signature"],
    ["unexpected updater response", "unknown"],
  ])("classifies '%s' as %s", async (message, code) => {
    checkMock.mockRejectedValueOnce(new Error(message))
    await expect(checkForUpdate()).rejects.toEqual(
      expect.objectContaining({ code, phase: "check" })
    )
  })
})

describe("downloadUpdate + installUpdate", () => {
  it("downloads once and can install without relaunching", async () => {
    const download = jest.fn(async () => {})
    const install = jest.fn(async () => {})
    const close = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({ version: "2.0.0", download, install, close })

    expect(await downloadUpdate()).toBe("downloaded")
    expect(await downloadUpdate()).toBe("downloaded")
    expect(download).toHaveBeenCalledTimes(1)

    expect(await installUpdate({ relaunch: false })).toBe("installed")
    expect(install).toHaveBeenCalledTimes(1)
    expect(relaunchMock).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("deduplicates concurrent downloads", async () => {
    let resolveDownload!: () => void
    const download = jest.fn(() => new Promise<void>((resolve) => (resolveDownload = resolve)))
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      download,
      install: jest.fn(async () => {}),
      close: jest.fn(async () => {}),
    })

    const first = downloadUpdate()
    await waitForMockCall(download)
    const second = downloadUpdate()
    expect(download).toHaveBeenCalledTimes(1)
    resolveDownload()
    await expect(Promise.all([first, second])).resolves.toEqual(["downloaded", "downloaded"])
  })

  it("keeps checks on the active handle while a download is running", async () => {
    let resolveDownload!: () => void
    const download = jest.fn(() => new Promise<void>((resolve) => (resolveDownload = resolve)))
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      body: "notes",
      download,
      install: jest.fn(async () => {}),
    })
    const pending = downloadUpdate()
    await waitForMockCall(download)

    await expect(checkForUpdate()).resolves.toEqual({
      version: "2.0.0",
      body: "notes",
      date: undefined,
    })
    expect(checkMock).toHaveBeenCalledTimes(1)
    resolveDownload()
    await pending
  })

  it("supports web no-ops for download, install, and relaunch", async () => {
    isTauriMock.mockReturnValue(false)
    await expect(downloadUpdate()).resolves.toBe("web")
    await expect(installUpdate()).resolves.toBe("web")
    await expect(relaunchAfterUpdate()).resolves.toBeUndefined()
  })

  it("classifies install and relaunch failures by phase", async () => {
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      download: jest.fn(async () => {}),
      install: jest.fn(async () => {
        throw new Error("disk write failed")
      }),
    })
    await expect(installUpdate()).rejects.toEqual(
      expect.objectContaining({ code: "install", phase: "install" })
    )

    __resetPendingUpdate()
    relaunchMock.mockRejectedValueOnce(new Error("restart failed"))
    await expect(relaunchAfterUpdate()).rejects.toEqual(
      expect.objectContaining({ code: "relaunch", phase: "relaunch" })
    )
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
    const download = jest.fn(async () => {})
    const install = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({ version: "2.0.0", download, install })
    expect(await downloadAndInstallUpdate()).toBe("relaunching")
    expect(download).toHaveBeenCalled()
    expect(install).toHaveBeenCalled()
    expect(relaunchMock).toHaveBeenCalled()
  })

  it("reuses the handle cached by checkForUpdate without a second check()", async () => {
    const download = jest.fn(async () => {})
    const install = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({ version: "2.0.0", body: "x", download, install })
    await checkForUpdate()
    expect(checkMock).toHaveBeenCalledTimes(1)

    expect(await downloadAndInstallUpdate()).toBe("relaunching")
    // No second network round-trip: the cached handle was reused.
    expect(checkMock).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalled()
    expect(install).toHaveBeenCalled()
    expect(relaunchMock).toHaveBeenCalled()
  })

  it("re-checks when the cached handle has aged past its TTL", async () => {
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000)
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      download: jest.fn(async () => {}),
      install: jest.fn(async () => {}),
    })
    await checkForUpdate()
    expect(checkMock).toHaveBeenCalledTimes(1)

    // Jump past the 10-minute reuse window: the stale handle must be discarded.
    nowSpy.mockReturnValue(1_000 + 11 * 60 * 1000)
    const freshDownload = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({
      version: "2.0.1",
      download: freshDownload,
      install: jest.fn(async () => {}),
    })
    expect(await downloadAndInstallUpdate()).toBe("relaunching")
    expect(checkMock).toHaveBeenCalledTimes(2)
    expect(freshDownload).toHaveBeenCalled()
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
    const download = jest.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } })
      onEvent?.({ event: "Progress", data: { chunkLength: 40 } })
      onEvent?.({ event: "Progress", data: { chunkLength: 60 } })
      onEvent?.({ event: "Finished" })
    })
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      download,
      install: jest.fn(async () => {}),
    })
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
    const download = jest.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: "Started", data: {} })
      onEvent?.({ event: "Progress", data: { chunkLength: 25 } })
      onEvent?.({ event: "Finished" })
    })
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      download,
      install: jest.fn(async () => {}),
    })
    const ticks: Array<{ downloaded: number; total?: number }> = []
    await downloadAndInstallUpdate((p) => ticks.push(p))
    expect(ticks).toEqual([
      { downloaded: 0, total: undefined },
      { downloaded: 25, total: undefined },
      { downloaded: 25, total: undefined },
    ])
  })

  it("propagates an install failure before relaunch", async () => {
    const download = jest.fn(async () => {
      throw new Error("disk full")
    })
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      download,
      install: jest.fn(async () => {}),
    })
    await expect(downloadAndInstallUpdate()).rejects.toThrow("disk full")
    expect(relaunchMock).not.toHaveBeenCalled()
  })
})
