/**
 * @jest-environment jsdom
 */
import { act, render, waitFor } from "@testing-library/react"

const nativeMobile = jest.fn(() => false)
const osFamily = jest.fn(() => "android")
const playStatus = jest.fn(async () => ({ available: true }))
const updateInfo = jest.fn(async () => ({ kind: "ok", value: { downloaded: false } }))
const unsubscribeResume = jest.fn()
const unsubscribeDownloaded = jest.fn()
const resumeListener = jest.fn(
  async (_handler: () => void): Promise<() => void> => unsubscribeResume
)
const downloadedListener = jest.fn(
  async (_handler: () => void): Promise<() => void> => unsubscribeDownloaded
)
jest.mock("@/lib/platform/detect", () => ({ isNativeMobile: () => nativeMobile() }))
jest.mock("@/lib/platform/os", () => ({ detectOsFamily: () => osFamily() }))
jest.mock("@/lib/capacitor/google-play-services", () => ({
  getGooglePlayServicesStatus: () => playStatus(),
}))
jest.mock("@/lib/capacitor/app", () => ({
  subscribeResume: (handler: () => void) => resumeListener(handler),
}))
jest.mock("@/lib/capacitor/app-update", () => ({
  getAppUpdateInfo: () => updateInfo(),
  subscribeFlexibleUpdateDownloaded: (handler: () => void) => downloadedListener(handler),
}))

const toastSuccess = jest.fn()
const toastWarning = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (m: string, o?: unknown) => toastSuccess(m, o),
    warning: (m: string, o?: unknown) => toastWarning(m, o),
  },
}))

jest.mock("@cognia/logging", () => ({
  loggers: { app: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))

const openUpdateCenter = jest.fn()
jest.mock("@/lib/updates/open-update-center", () => ({
  openUpdateCenter: (...args: unknown[]) => openUpdateCenter(...args),
}))

const coordinator = {
  restore: jest.fn(async () => {}),
  check: jest.fn(async () => [] as unknown[]),
}
const center = { notifyCritical: true }
jest.mock("@/lib/updates/runtime", () => ({
  getUpdateCoordinator: () => coordinator,
  readUpdateCenterSettings: () => center,
}))

const updateSettings = { autoCheck: true, checkIntervalMinutes: 360 }
jest.mock("@/lib/tauri/updater", () => ({ resolveUpdateSettings: () => updateSettings }))

const settingsState = { settings: { updates: {} } }
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
}))

import { UpdateCenterInitializer, __resetUpdateSweepThrottle } from "./update-center-initializer"

const ORIGINAL_ENV = process.env.NODE_ENV

function row(criticality: "routine" | "critical", key = "desktop:app") {
  return {
    key,
    state: "available",
    candidate: { targetVersion: "1.1.0", criticality },
  }
}

beforeEach(() => {
  nativeMobile.mockReturnValue(false)
  osFamily.mockReturnValue("android")
  playStatus.mockReset().mockResolvedValue({ available: true })
  updateInfo.mockReset().mockResolvedValue({ kind: "ok", value: { downloaded: false } })
  resumeListener.mockReset().mockResolvedValue(unsubscribeResume)
  downloadedListener.mockReset().mockResolvedValue(unsubscribeDownloaded)
  unsubscribeResume.mockClear()
  unsubscribeDownloaded.mockClear()
  __resetUpdateSweepThrottle()
  coordinator.restore.mockClear()
  coordinator.check.mockClear()
  coordinator.check.mockResolvedValue([])
  toastSuccess.mockClear()
  toastWarning.mockClear()
  openUpdateCenter.mockClear()
  updateSettings.autoCheck = true
  center.notifyCritical = true
  Object.defineProperty(process.env, "NODE_ENV", { value: "production", configurable: true })
})

afterAll(() => {
  Object.defineProperty(process.env, "NODE_ENV", { value: ORIGINAL_ENV, configurable: true })
})

describe("UpdateCenterInitializer", () => {
  it("rechecks downloaded updates on resume and native completion without installing", async () => {
    nativeMobile.mockReturnValue(true)
    updateSettings.autoCheck = false
    center.notifyCritical = false
    const ready = {
      ...row("routine", "mobile-android:app"),
      kind: "mobile-android",
      candidate: {
        targetVersion: "200",
        action: "install-in-app",
        source: "store",
        criticality: "routine",
      },
    }
    coordinator.check.mockResolvedValue([ready])
    const { unmount } = render(<UpdateCenterInitializer />)
    await waitFor(() => expect(updateInfo).toHaveBeenCalled())
    expect(coordinator.check).not.toHaveBeenCalled()
    updateInfo.mockResolvedValue({ kind: "ok", value: { downloaded: true } })
    await act(async () => {
      resumeListener.mock.calls[0][0]()
    })
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Restart to finish", expect.any(Object))
    )
    expect(coordinator.check).toHaveBeenCalledWith({ kind: "mobile-android", manual: false })
    const options = toastSuccess.mock.calls[0][1] as { action: { onClick: () => void } }
    options.action.onClick()
    expect(openUpdateCenter).toHaveBeenCalledWith({ focusKey: "mobile-android:app" })
    await act(async () => {
      downloadedListener.mock.calls[0][0]()
    })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    unmount()
    expect(unsubscribeResume).toHaveBeenCalledTimes(1)
    expect(unsubscribeDownloaded).toHaveBeenCalledTimes(1)
  })

  it("skips native update probes and listeners without GMS", async () => {
    nativeMobile.mockReturnValue(true)
    playStatus.mockResolvedValue({ available: false })
    render(<UpdateCenterInitializer />)
    await waitFor(() => expect(playStatus).toHaveBeenCalled())
    expect(updateInfo).not.toHaveBeenCalled()
    expect(resumeListener).not.toHaveBeenCalled()
    expect(downloadedListener).not.toHaveBeenCalled()
  })

  it("rechecks a completion event received while an older readiness probe is pending", async () => {
    nativeMobile.mockReturnValue(true)
    updateSettings.autoCheck = false
    center.notifyCritical = false
    let finish: ((value: { kind: string; value: { downloaded: boolean } }) => void) | undefined
    updateInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    updateInfo.mockResolvedValue({ kind: "ok", value: { downloaded: true } })
    coordinator.check.mockResolvedValue([
      {
        key: "mobile-android:app",
        kind: "mobile-android",
        state: "available",
        candidate: { source: "store", action: "install-in-app", targetVersion: "200" },
      },
    ])
    render(<UpdateCenterInitializer />)
    await waitFor(() => expect(updateInfo).toHaveBeenCalledTimes(1))
    await act(async () => {
      downloadedListener.mock.calls[0][0]()
      finish?.({ kind: "ok", value: { downloaded: false } })
    })
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    expect(updateInfo).toHaveBeenCalledTimes(2)
  })

  it("cleans up listeners that resolve after unmount and ignores later callbacks", async () => {
    nativeMobile.mockReturnValue(true)
    let finish: ((remove: () => void) => void) | undefined
    downloadedListener.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { unmount } = render(<UpdateCenterInitializer />)
    await waitFor(() => expect(downloadedListener).toHaveBeenCalled())
    unmount()
    await act(async () => {
      finish?.(unsubscribeDownloaded)
    })
    expect(unsubscribeResume).toHaveBeenCalledTimes(1)
    expect(unsubscribeDownloaded).toHaveBeenCalledTimes(1)
    const reads = updateInfo.mock.calls.length
    await act(async () => {
      downloadedListener.mock.calls[0][0]()
    })
    expect(updateInfo).toHaveBeenCalledTimes(reads)
  })

  it("renders nothing", () => {
    const { container } = render(<UpdateCenterInitializer />)
    expect(container.firstChild).toBeNull()
  })

  it("stays out of the way in development", async () => {
    Object.defineProperty(process.env, "NODE_ENV", { value: "development", configurable: true })
    render(<UpdateCenterInitializer />)
    await waitFor(() => expect(coordinator.check).not.toHaveBeenCalled())
  })

  it("reconciles persisted state before checking anything", async () => {
    render(<UpdateCenterInitializer />)
    await waitFor(() => expect(coordinator.restore).toHaveBeenCalled())
    expect(coordinator.check).toHaveBeenCalled()
  })

  it("announces an available update with an action that opens the center", async () => {
    coordinator.check.mockResolvedValue([row("routine")])
    render(<UpdateCenterInitializer />)
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    const options = toastSuccess.mock.calls[0][1] as { action: { onClick: () => void } }
    options.action.onClick()
    expect(openUpdateCenter).toHaveBeenCalled()
  })

  it("uses a warning, not a blocking dialog, for a critical update", async () => {
    coordinator.check.mockResolvedValue([row("critical")])
    render(<UpdateCenterInitializer />)
    await waitFor(() => expect(toastWarning).toHaveBeenCalled())
    expect(toastWarning.mock.calls[0][0]).toBe("A critical update is available")
  })

  it("stays silent when nothing is actionable", async () => {
    coordinator.check.mockResolvedValue([{ key: "a", state: "current", candidate: null }])
    render(<UpdateCenterInitializer />)
    await waitFor(() => expect(coordinator.check).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("still announces a critical update when automatic checks are off", async () => {
    updateSettings.autoCheck = false
    coordinator.check.mockResolvedValue([row("critical")])
    render(<UpdateCenterInitializer />)
    await waitFor(() => expect(toastWarning).toHaveBeenCalled())
  })

  it("stays quiet about routine updates when automatic checks are off", async () => {
    updateSettings.autoCheck = false
    coordinator.check.mockResolvedValue([row("routine")])
    render(<UpdateCenterInitializer />)
    await waitFor(() => expect(coordinator.check).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("does nothing at all when both switches are off", async () => {
    updateSettings.autoCheck = false
    center.notifyCritical = false
    render(<UpdateCenterInitializer />)
    await waitFor(() => expect(coordinator.restore).toHaveBeenCalled())
    expect(coordinator.check).not.toHaveBeenCalled()
  })

  it("squashes the boot storm across remounts", async () => {
    const first = render(<UpdateCenterInitializer />)
    await waitFor(() => expect(coordinator.check).toHaveBeenCalledTimes(1))
    first.unmount()
    render(<UpdateCenterInitializer />)
    await waitFor(() => expect(coordinator.restore).toHaveBeenCalledTimes(1))
    expect(coordinator.check).toHaveBeenCalledTimes(1)
  })

  it("survives a sweep that throws", async () => {
    coordinator.check.mockRejectedValue(new Error("offline"))
    render(<UpdateCenterInitializer />)
    await waitFor(() => expect(coordinator.check).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
