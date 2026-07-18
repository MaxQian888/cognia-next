/**
 * @jest-environment jsdom
 */

import { render, waitFor, act } from "@testing-library/react"

const isTauriMock = jest.fn<boolean, []>(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const checkForUpdateMock = jest.fn()
const downloadAndInstallMock = jest.fn()
const downloadUpdateMock = jest.fn()
const installUpdateMock = jest.fn()
const relaunchAfterUpdateMock = jest.fn()
jest.mock("@/lib/tauri/updater", () => ({
  checkForUpdate: () => checkForUpdateMock(),
  downloadAndInstallUpdate: (...a: unknown[]) => downloadAndInstallMock(...a),
  downloadUpdate: (...a: unknown[]) => downloadUpdateMock(...a),
  installUpdate: (...a: unknown[]) => installUpdateMock(...a),
  isUpdateErrorPhase: (error: unknown, phase: string) =>
    (error as { phase?: string } | null)?.phase === phase,
  relaunchAfterUpdate: () => relaunchAfterUpdateMock(),
  resolveUpdateSettings: (raw?: Record<string, unknown>) => ({
    autoCheck: true,
    checkIntervalMinutes: 360,
    autoDownload: false,
    relaunchAfterInstall: true,
    requestTimeoutSeconds: 30,
    useProxy: true,
    ...raw,
  }),
}))

jest.mock("@cognia/logging", () => ({
  loggers: { app: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } },
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    loading: jest.fn(() => "toast-id"),
  },
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const saveMock = jest.fn(async () => {})
const defaultUpdateSettings = {
  autoCheck: true,
  checkIntervalMinutes: 360,
  autoDownload: false,
  relaunchAfterInstall: true,
  requestTimeoutSeconds: 30,
  useProxy: true,
}
const settingsState = {
  settings: { updates: { ...defaultUpdateSettings } } as Record<string, unknown>,
  save: saveMock,
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
}))

import { toast } from "sonner"
import { loggers } from "@cognia/logging"
import { UpdateCheckInitializer, __resetAutoCheckThrottle } from "./update-check-initializer"

const toastMock = toast as unknown as {
  success: jest.Mock
  error: jest.Mock
  info: jest.Mock
  loading: jest.Mock
}
const warnMock = (loggers.app as unknown as { warn: jest.Mock }).warn
const debugMock = (loggers.app as unknown as { debug: jest.Mock }).debug
const errorMock = (loggers.app as unknown as { error: jest.Mock }).error

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  settingsState.settings = { updates: { ...defaultUpdateSettings } }
  __resetAutoCheckThrottle()
})

describe("UpdateCheckInitializer", () => {
  it("renders nothing visible", () => {
    checkForUpdateMock.mockResolvedValue(null)
    const { container } = render(<UpdateCheckInitializer />)
    expect(container.firstChild).toBeNull()
  })

  it("does not check off the desktop shell", async () => {
    isTauriMock.mockReturnValue(false)
    render(<UpdateCheckInitializer />)
    await Promise.resolve()
    expect(checkForUpdateMock).not.toHaveBeenCalled()
  })

  it("does not check when auto-check is disabled", async () => {
    settingsState.settings = { updates: { ...defaultUpdateSettings, autoCheck: false } }
    render(<UpdateCheckInitializer />)
    await Promise.resolve()
    expect(checkForUpdateMock).not.toHaveBeenCalled()
  })

  it("defaults to enabled when the setting is missing", async () => {
    settingsState.settings = {}
    checkForUpdateMock.mockResolvedValue(null)
    render(<UpdateCheckInitializer />)
    await waitFor(() => expect(checkForUpdateMock).toHaveBeenCalled())
  })

  it("toasts an available update whose action installs in one click", async () => {
    checkForUpdateMock.mockResolvedValue({ version: "9.9.9", body: "Notes" })
    downloadAndInstallMock.mockResolvedValue("relaunching")
    render(<UpdateCheckInitializer />)
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        'updateAvailableBackground:{"version":"9.9.9"}',
        expect.objectContaining({ action: expect.any(Object) })
      )
    )
    const opts = toastMock.success.mock.calls[0][1] as {
      action: { onClick: () => void }
    }
    await act(async () => {
      opts.action.onClick()
      await Promise.resolve()
    })
    expect(toastMock.loading).toHaveBeenCalledWith("installing")
    expect(downloadAndInstallMock).toHaveBeenCalled()
  })

  it("downloads in the background when auto-download is enabled", async () => {
    settingsState.settings = {
      updates: { ...defaultUpdateSettings, autoDownload: true },
    }
    checkForUpdateMock.mockResolvedValue({ version: "9.9.9", body: "Notes" })
    downloadUpdateMock.mockResolvedValue("downloaded")
    installUpdateMock.mockResolvedValue("relaunching")
    render(<UpdateCheckInitializer />)

    await waitFor(() => expect(downloadUpdateMock).toHaveBeenCalled())
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        'updateDownloadedBackground:{"version":"9.9.9"}',
        expect.objectContaining({ action: expect.any(Object), id: "toast-id" })
      )
    )
    const opts = toastMock.success.mock.calls.at(-1)?.[1] as {
      action: { onClick: () => void }
    }
    await act(async () => {
      opts.action.onClick()
      await Promise.resolve()
    })
    expect(installUpdateMock).toHaveBeenCalledWith({ relaunch: true })
  })

  it("offers restart after installing without an immediate relaunch", async () => {
    settingsState.settings = {
      updates: { ...defaultUpdateSettings, relaunchAfterInstall: false },
    }
    checkForUpdateMock.mockResolvedValue({ version: "9.9.9" })
    downloadAndInstallMock.mockResolvedValue("installed")
    render(<UpdateCheckInitializer />)
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    const availableOptions = toastMock.success.mock.calls[0][1] as {
      action: { onClick: () => void }
    }
    await act(async () => {
      availableOptions.action.onClick()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        "installedRestartRequired",
        expect.objectContaining({ action: expect.any(Object), id: "toast-id" })
      )
    )
    const installedCall = toastMock.success.mock.calls.find(
      ([message]) => message === "installedRestartRequired"
    )
    const installedOptions = installedCall?.[1] as { action: { onClick: () => void } }
    await act(async () => {
      installedOptions.action.onClick()
      await Promise.resolve()
    })
    expect(relaunchAfterUpdateMock).toHaveBeenCalled()
  })

  it("surfaces a manual restart failure", async () => {
    settingsState.settings = {
      updates: { ...defaultUpdateSettings, relaunchAfterInstall: false },
    }
    checkForUpdateMock.mockResolvedValue({ version: "9.9.9" })
    downloadAndInstallMock.mockResolvedValue("installed")
    relaunchAfterUpdateMock.mockRejectedValueOnce("restart denied")
    render(<UpdateCheckInitializer />)
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    const availableOptions = toastMock.success.mock.calls[0][1] as {
      action: { onClick: () => void }
    }
    await act(async () => {
      availableOptions.action.onClick()
      await Promise.resolve()
    })
    const installedCall = toastMock.success.mock.calls.find(
      ([message]) => message === "installedRestartRequired"
    )
    const installedOptions = installedCall?.[1] as { action: { onClick: () => void } }
    await act(async () => {
      installedOptions.action.onClick()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'updateRelaunchFailed:{"error":"restart denied"}'
      )
    )
  })

  it("falls back to manual installation when background download fails", async () => {
    settingsState.settings = {
      updates: { ...defaultUpdateSettings, autoDownload: true },
    }
    checkForUpdateMock.mockResolvedValue({ version: "9.9.9" })
    downloadUpdateMock.mockRejectedValue(new Error("offline"))
    render(<UpdateCheckInitializer />)

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        'updateAvailableBackground:{"version":"9.9.9"}',
        expect.objectContaining({ action: expect.any(Object), id: "toast-id" })
      )
    )
    expect(warnMock).toHaveBeenCalledWith(
      "about.autoUpdateDownloadFailed",
      expect.objectContaining({ err: expect.stringContaining("offline") })
    )
  })

  it("reports when an auto-downloaded update vanishes", async () => {
    settingsState.settings = {
      updates: { ...defaultUpdateSettings, autoDownload: true },
    }
    checkForUpdateMock.mockResolvedValue({ version: "9.9.9" })
    downloadUpdateMock.mockResolvedValue("noLongerAvailable")
    render(<UpdateCheckInitializer />)

    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith("updateNoLongerAvailable", { id: "toast-id" })
    )
  })

  it("persists the successful background check timestamp", async () => {
    checkForUpdateMock.mockResolvedValue(null)
    render(<UpdateCheckInitializer />)
    await waitFor(() => expect(checkForUpdateMock).toHaveBeenCalled())
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ lastUpdateCheckAt: expect.any(Number) })
    )
  })

  it("keeps checking when timestamp persistence fails", async () => {
    saveMock.mockRejectedValueOnce(new Error("db unavailable"))
    checkForUpdateMock.mockResolvedValue({ version: "9.9.9" })
    render(<UpdateCheckInitializer />)

    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    expect(warnMock).toHaveBeenCalledWith(
      "about.autoUpdateTimestampPersistFailed",
      expect.objectContaining({ err: expect.stringContaining("db unavailable") })
    )
  })

  it("surfaces a background install failure via an error toast + log", async () => {
    checkForUpdateMock.mockResolvedValue({ version: "9.9.9" })
    downloadAndInstallMock.mockRejectedValue(new Error("disk full"))
    render(<UpdateCheckInitializer />)
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    const opts = toastMock.success.mock.calls[0][1] as { action: { onClick: () => void } }
    await act(async () => {
      opts.action.onClick()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('updateInstallFailed:{"error":"disk full"}', {
        id: "toast-id",
      })
    )
    expect(errorMock).toHaveBeenCalledWith("about.autoUpdateInstallFailed", expect.any(Error))
  })

  it("reports when the update vanished before the background install", async () => {
    checkForUpdateMock.mockResolvedValue({ version: "9.9.9" })
    downloadAndInstallMock.mockResolvedValue("noLongerAvailable")
    render(<UpdateCheckInitializer />)
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    const opts = toastMock.success.mock.calls[0][1] as { action: { onClick: () => void } }
    await act(async () => {
      opts.action.onClick()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith("updateNoLongerAvailable", { id: "toast-id" })
    )
  })

  it("stays silent when already current", async () => {
    checkForUpdateMock.mockResolvedValue(null)
    render(<UpdateCheckInitializer />)
    await waitFor(() => expect(checkForUpdateMock).toHaveBeenCalled())
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("swallows a check failure via a warn log", async () => {
    checkForUpdateMock.mockRejectedValue(new Error("offline"))
    render(<UpdateCheckInitializer />)
    await waitFor(() =>
      expect(warnMock).toHaveBeenCalledWith("about.autoUpdateCheckFailed", expect.any(Object))
    )
    expect(debugMock).not.toHaveBeenCalled()
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("downgrades a no-release endpoint (404) to a debug log, not a warn", async () => {
    checkForUpdateMock.mockRejectedValue(
      new Error("Could not fetch a valid release JSON from the remote")
    )
    render(<UpdateCheckInitializer />)
    await waitFor(() =>
      expect(debugMock).toHaveBeenCalledWith("about.autoUpdateCheckNoRelease", expect.any(Object))
    )
    expect(warnMock).not.toHaveBeenCalled()
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("treats a bare 404 status as a no-release debug log", async () => {
    checkForUpdateMock.mockRejectedValue(new Error("Request failed with status code 404"))
    render(<UpdateCheckInitializer />)
    await waitFor(() =>
      expect(debugMock).toHaveBeenCalledWith("about.autoUpdateCheckNoRelease", expect.any(Object))
    )
    expect(warnMock).not.toHaveBeenCalled()
  })

  it("throttles boot-storm re-mounts to a single check", async () => {
    checkForUpdateMock.mockResolvedValue(null)
    const first = render(<UpdateCheckInitializer />)
    await waitFor(() => expect(checkForUpdateMock).toHaveBeenCalledTimes(1))
    first.unmount()
    // StrictMode double-invoke / settings-hydration re-subscribe: a remount
    // within the throttle gap must NOT hit the endpoint again.
    render(<UpdateCheckInitializer />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(checkForUpdateMock).toHaveBeenCalledTimes(1)
  })

  it("re-checks on the interval but does not re-toast the same version", async () => {
    jest.useFakeTimers()
    try {
      checkForUpdateMock.mockResolvedValue({ version: "1.0.0" })
      render(<UpdateCheckInitializer />)
      // flush the immediate run
      await act(async () => {
        await Promise.resolve()
      })
      expect(checkForUpdateMock).toHaveBeenCalledTimes(1)
      expect(toastMock.success).toHaveBeenCalledTimes(1)
      // advance 6h → interval fires again
      await act(async () => {
        jest.advanceTimersByTime(6 * 60 * 60 * 1000)
        await Promise.resolve()
      })
      expect(checkForUpdateMock).toHaveBeenCalledTimes(2)
      // same version → no second toast
      expect(toastMock.success).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it("offers restart recovery when install succeeded but automatic relaunch failed", async () => {
    checkForUpdateMock.mockResolvedValue({ version: "9.9.9" })
    downloadAndInstallMock.mockRejectedValue(
      Object.assign(new Error("restart denied"), { phase: "relaunch" })
    )
    render(<UpdateCheckInitializer />)
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    const availableOptions = toastMock.success.mock.calls[0][1] as {
      action: { onClick: () => void }
    }

    await act(async () => {
      availableOptions.action.onClick()
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'updateRelaunchFailed:{"error":"restart denied"}',
        expect.objectContaining({ action: expect.any(Object), id: "toast-id" })
      )
    )
    expect(errorMock).toHaveBeenCalledWith(
      "about.autoUpdateRelaunchFailed",
      expect.objectContaining({ phase: "relaunch" })
    )
  })

  it("does not fetch merely because download or relaunch preferences changed", async () => {
    jest.useFakeTimers()
    try {
      checkForUpdateMock.mockResolvedValue(null)
      const { rerender } = render(<UpdateCheckInitializer />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(checkForUpdateMock).toHaveBeenCalledTimes(1)

      jest.advanceTimersByTime(2 * 60 * 1000)
      settingsState.settings = {
        updates: {
          ...defaultUpdateSettings,
          autoDownload: true,
          relaunchAfterInstall: false,
        },
      }
      rerender(<UpdateCheckInitializer />)
      await act(async () => {
        await Promise.resolve()
      })

      expect(checkForUpdateMock).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })
})
