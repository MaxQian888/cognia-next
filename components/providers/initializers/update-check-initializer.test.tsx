/**
 * @jest-environment jsdom
 */

import { render, waitFor, act } from "@testing-library/react"

const isTauriMock = jest.fn<boolean, []>(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const checkForUpdateMock = jest.fn()
jest.mock("@/lib/tauri/updater", () => ({ checkForUpdate: () => checkForUpdateMock() }))

jest.mock("@/lib/logging", () => ({
  loggers: { app: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() } },
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const settingsState = { settings: { updates: { autoCheck: true } } as Record<string, unknown> }
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
}))

const requestOpenSettingsMock = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: { getState: () => ({ requestOpenSettings: requestOpenSettingsMock }) },
}))

import { toast } from "sonner"
import { loggers } from "@/lib/logging"
import { UpdateCheckInitializer } from "./update-check-initializer"

const toastMock = toast as unknown as { success: jest.Mock; error: jest.Mock }
const warnMock = (loggers.app as unknown as { warn: jest.Mock }).warn
const debugMock = (loggers.app as unknown as { debug: jest.Mock }).debug

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  settingsState.settings = { updates: { autoCheck: true } }
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
    settingsState.settings = { updates: { autoCheck: false } }
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

  it("toasts an available update with a go-install action", async () => {
    checkForUpdateMock.mockResolvedValue({ version: "9.9.9", body: "Notes" })
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
    opts.action.onClick()
    expect(requestOpenSettingsMock).toHaveBeenCalledWith("about")
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
})
