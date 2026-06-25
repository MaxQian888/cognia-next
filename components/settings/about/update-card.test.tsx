/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const isTauriMock = jest.fn<boolean, []>(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const checkMock = jest.fn()
jest.mock("@tauri-apps/plugin-updater", () => ({ check: () => checkMock() }), { virtual: true })

const relaunchMock = jest.fn(async () => {})
jest.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunchMock() }), {
  virtual: true,
})

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

const saveMock = jest.fn(async () => {})
const settingsState = {
  settings: { updates: { autoCheck: true } } as Record<string, unknown>,
  save: saveMock,
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
}))

import { toast } from "sonner"
import { __resetPendingUpdate } from "@/lib/tauri/updater"
import { UpdateCard } from "./update-card"

const toastMock = toast as unknown as {
  success: jest.Mock
  error: jest.Mock
  info: jest.Mock
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  settingsState.settings = { updates: { autoCheck: true } }
  // The updater caches the last `check()` handle module-side; clear it so each
  // case starts cold.
  __resetPendingUpdate()
})

describe("<UpdateCard />", () => {
  it("disables checking and explains on web", () => {
    isTauriMock.mockReturnValue(false)
    render(<UpdateCard />)
    expect(screen.getByTestId("updates-desktop-only")).toBeInTheDocument()
    expect(screen.getByTestId("check-updates")).toBeDisabled()
  })

  it("reports already-latest and records last-checked", async () => {
    checkMock.mockResolvedValueOnce(null)
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    expect(screen.getByTestId("row-last-checked")).toBeInTheDocument()
  })

  it("surfaces an available update and installs it", async () => {
    const update = { version: "1.0.0", body: "Notes", downloadAndInstall: jest.fn(async () => {}) }
    checkMock.mockResolvedValue(update)
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("update-alert")).toHaveTextContent("1.0.0"))

    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalled())
    await waitFor(() => expect(relaunchMock).toHaveBeenCalled())
  })

  it("reports a check failure via toast", async () => {
    checkMock.mockRejectedValueOnce(new Error("network"))
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })

  it("reports when the update vanished before install", async () => {
    // handleCheck caches an update; if the cache is dropped (e.g. another
    // surface re-checked to nothing) the install path re-checks and finds none.
    checkMock.mockResolvedValueOnce({ version: "1.0.0", body: "Notes" })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())
    __resetPendingUpdate()
    checkMock.mockResolvedValueOnce(null)
    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(toastMock.info).toHaveBeenCalled())
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it("surfaces an install failure via toast and resets the installing state", async () => {
    const downloadAndInstall = jest.fn(async () => {
      throw new Error("disk full")
    })
    // The cached check handle is reused at install time, so it carries the
    // throwing installer.
    checkMock.mockResolvedValueOnce({ version: "1.0.0", body: "Notes", downloadAndInstall })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(relaunchMock).not.toHaveBeenCalled()
    // Failure re-enables the button (installing state cleared).
    await waitFor(() => expect(screen.getByTestId("install-update")).not.toBeDisabled())
    expect(screen.queryByTestId("install-progress")).not.toBeInTheDocument()
  })

  it("shows determinate download progress while installing", async () => {
    const downloadAndInstall = jest.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 200 } })
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } })
    })
    checkMock.mockResolvedValue({ version: "1.0.0", body: "Notes", downloadAndInstall })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(screen.getByTestId("install-progress")).toHaveTextContent("50%"))
    await waitFor(() => expect(relaunchMock).toHaveBeenCalled())
  })

  it("shows indeterminate progress when the server omits a content length", async () => {
    const downloadAndInstall = jest.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: "Started", data: {} })
      onEvent?.({ event: "Progress", data: { chunkLength: 25 } })
    })
    checkMock.mockResolvedValue({ version: "1.0.0", body: "Notes", downloadAndInstall })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(relaunchMock).toHaveBeenCalled())
    // No Content-Length → no percent figure, just the "installing" label.
    expect(screen.getByTestId("install-progress")).not.toHaveTextContent("%")
  })

  it("stringifies a non-Error install rejection in the failure toast", async () => {
    const downloadAndInstall = jest.fn(async () => {
      throw "kaboom"
    })
    checkMock.mockResolvedValueOnce({ version: "1.0.0", body: "Notes", downloadAndInstall })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })

  it("persists the auto-check toggle via the settings store", async () => {
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("auto-check-updates-toggle"))
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ updates: { autoCheck: false } }))
  })

  it("hides the auto-check toggle on web", () => {
    isTauriMock.mockReturnValue(false)
    render(<UpdateCard />)
    expect(screen.queryByTestId("auto-check-updates-toggle")).not.toBeInTheDocument()
  })

  it("defaults the auto-check toggle to on when settings are absent", () => {
    settingsState.settings = {}
    render(<UpdateCard />)
    expect(screen.getByTestId("auto-check-updates-toggle")).toBeChecked()
  })
})
