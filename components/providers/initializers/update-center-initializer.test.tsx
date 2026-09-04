/**
 * @jest-environment jsdom
 */
import { render, waitFor } from "@testing-library/react"

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
