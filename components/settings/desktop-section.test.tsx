/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const getCloseBehaviorMock = jest.fn().mockResolvedValue("ask")
const setCloseBehaviorMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/close-behavior", () => ({
  getCloseBehavior: () => getCloseBehaviorMock(),
  setCloseBehavior: (...a: unknown[]) => setCloseBehaviorMock(...a),
}))

const isAutostartEnabledMock = jest.fn().mockResolvedValue(false)
const setAutostartMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/autostart", () => ({
  isAutostartEnabled: () => isAutostartEnabledMock(),
  setAutostart: (...args: unknown[]) => setAutostartMock(...args),
}))
const writeClipboardTextMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (...args: unknown[]) => writeClipboardTextMock(...args),
}))
const openExternalMock = jest.fn().mockResolvedValue(undefined)
const revealInExplorerMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (...args: unknown[]) => openExternalMock(...args),
  revealInExplorer: (...args: unknown[]) => revealInExplorerMock(...args),
}))
const getOsInfoMock = jest.fn().mockResolvedValue({
  osType: "Windows",
  platform: "windows",
  arch: "x86_64",
  version: "11",
  family: "windows",
  locale: "en-US",
  hostname: "host",
})
jest.mock("@/lib/tauri/os", () => ({
  getOsInfo: () => getOsInfoMock(),
}))
const invokeMock = jest.fn().mockResolvedValue("ok")
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))
const appDataDirMock = jest.fn().mockResolvedValue("/data")
jest.mock("@tauri-apps/api/path", () => ({ appDataDir: () => appDataDirMock() }))
jest.mock("@cognia/logging", () => ({
  loggers: { app: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))
const toastSuccessMock = jest.fn()
const toastErrorMock = jest.fn()
const toastMessageMock = jest.fn()
const toastWarningMock = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    message: (...args: unknown[]) => toastMessageMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
  },
}))
const ensureNotificationPermissionMock = jest.fn().mockResolvedValue("granted")
const notifyMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/notification", () => ({
  ensureNotificationPermission: () => ensureNotificationPermissionMock(),
  notify: (...args: unknown[]) => notifyMock(...args),
}))
jest.mock("./tray-section", () => ({ TraySection: () => null }))

const saveSettingsMock = jest.fn().mockResolvedValue(undefined)
let cookieImportEnabled = false
let settingsLoaded = true
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: settingsLoaded ? { browserCookieImportEnabled: cookieImportEnabled } : null,
      save: saveSettingsMock,
    }),
}))

import { DesktopSection } from "./desktop-section"

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  getCloseBehaviorMock.mockResolvedValue("ask")
  setCloseBehaviorMock.mockResolvedValue(undefined)
  isAutostartEnabledMock.mockResolvedValue(false)
  setAutostartMock.mockResolvedValue(undefined)
  writeClipboardTextMock.mockResolvedValue(undefined)
  openExternalMock.mockResolvedValue(undefined)
  revealInExplorerMock.mockResolvedValue(undefined)
  getOsInfoMock.mockResolvedValue({
    osType: "Windows",
    platform: "windows",
    arch: "x86_64",
    version: "11",
    family: "windows",
    locale: "en-US",
    hostname: "host",
  })
  invokeMock.mockResolvedValue("ok")
  appDataDirMock.mockResolvedValue("/data")
  ensureNotificationPermissionMock.mockResolvedValue("granted")
  notifyMock.mockResolvedValue(undefined)
  cookieImportEnabled = false
  settingsLoaded = true
  saveSettingsMock.mockClear()
})

it("renders the three close-behavior options", async () => {
  render(<DesktopSection />)
  await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(3))
  expect(screen.getByText("settings.desktop.closeBehaviorAsk")).toBeInTheDocument()
  expect(screen.getByText("settings.desktop.closeBehaviorTray")).toBeInTheDocument()
  expect(screen.getByText("settings.desktop.closeBehaviorQuit")).toBeInTheDocument()
})

it("persists the chosen behavior when a radio is selected", async () => {
  render(<DesktopSection />)
  const radios = await screen.findAllByRole("radio")
  await waitFor(() => expect(radios[1]).not.toBeDisabled())
  fireEvent.click(radios[1]) // "tray"
  await waitFor(() => expect(setCloseBehaviorMock).toHaveBeenCalledWith("tray"))
})

it("shows the web-only hint outside Tauri", () => {
  isTauriMock.mockReturnValue(false)
  render(<DesktopSection />)
  expect(screen.getByText("settings.desktop.title")).toBeInTheDocument()
  expect(screen.queryByRole("radio")).not.toBeInTheDocument()
})

it("persists the opt-in browser cookie import toggle", async () => {
  render(<DesktopSection />)
  await screen.findByText(/Windows \(windows\)/)
  fireEvent.click(screen.getByTestId("browser-cookie-import-toggle"))
  await waitFor(() =>
    expect(saveSettingsMock).toHaveBeenCalledWith({ browserCookieImportEnabled: true })
  )
})

it("reflects a persisted enabled cookie import setting", async () => {
  cookieImportEnabled = true
  render(<DesktopSection />)
  await screen.findByText(/Windows \(windows\)/)
  expect(screen.getByTestId("browser-cookie-import-toggle")).toBeChecked()
})

it("runs the desktop actions successfully", async () => {
  render(<DesktopSection />)
  await screen.findByText(/Windows \(windows\)/)

  fireEvent.click(screen.getByRole("switch", { name: "settings.desktop.launchAtLoginToggle" }))
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.revealDataDir" }))
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.copyDebug" }))
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.testNotification" }))
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.pingRust" }))
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.tauriDocs" }))

  await waitFor(() => {
    expect(setAutostartMock).toHaveBeenCalledWith(true)
    expect(revealInExplorerMock).toHaveBeenCalledWith("/data")
    expect(writeClipboardTextMock).toHaveBeenCalledWith(expect.stringContaining("OS: Windows 11"))
    expect(notifyMock).toHaveBeenCalledWith({
      title: "settings.desktop.notificationTitle",
      body: "settings.desktop.notificationBody",
    })
    expect(invokeMock).toHaveBeenCalledWith("greet", { name: "desktop" })
    expect(openExternalMock).toHaveBeenCalledWith("https://v2.tauri.app/plugin/")
  })
})

it("reports desktop action failures", async () => {
  setAutostartMock.mockRejectedValueOnce(new Error("autostart failed"))
  setCloseBehaviorMock.mockRejectedValueOnce("close failed")
  revealInExplorerMock.mockRejectedValueOnce(new Error("reveal failed"))
  writeClipboardTextMock.mockRejectedValueOnce("copy failed")
  invokeMock.mockRejectedValueOnce(new Error("ping failed"))

  render(<DesktopSection />)
  const radios = await screen.findAllByRole("radio")
  await waitFor(() => expect(radios[1]).not.toBeDisabled())
  fireEvent.click(screen.getByRole("switch", { name: "settings.desktop.launchAtLoginToggle" }))
  fireEvent.click(radios[1])
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.revealDataDir" }))
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.copyDebug" }))
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.pingRust" }))

  await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(5))
})

it("does not notify when desktop notification permission is denied", async () => {
  ensureNotificationPermissionMock.mockResolvedValueOnce("denied")
  render(<DesktopSection />)
  await screen.findByText(/Windows \(windows\)/)

  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.testNotification" }))

  await waitFor(() => expect(toastWarningMock).toHaveBeenCalled())
  expect(notifyMock).not.toHaveBeenCalled()
})

it("recovers when desktop metadata cannot be loaded", async () => {
  getOsInfoMock.mockRejectedValueOnce(new Error("metadata failed"))
  render(<DesktopSection />)
  expect(await screen.findByText("settings.desktop.osUnavailable")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.copyDebug" }))
  await waitFor(() =>
    expect(writeClipboardTextMock).toHaveBeenCalledWith(expect.stringContaining("OS: (unknown)"))
  )
})

it("formats non-Error desktop action failures", async () => {
  setAutostartMock.mockRejectedValueOnce("autostart failed")
  setCloseBehaviorMock.mockRejectedValueOnce(new Error("close failed"))
  revealInExplorerMock.mockRejectedValueOnce("reveal failed")
  writeClipboardTextMock.mockRejectedValueOnce(new Error("copy failed"))
  invokeMock.mockRejectedValueOnce("ping failed")

  render(<DesktopSection />)
  const radios = await screen.findAllByRole("radio")
  await waitFor(() => expect(radios[1]).not.toBeDisabled())
  fireEvent.click(screen.getByRole("switch", { name: "settings.desktop.launchAtLoginToggle" }))
  fireEvent.click(radios[1])
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.revealDataDir" }))
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.copyDebug" }))
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.pingRust" }))

  await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(5))
})

it("handles optional desktop metadata and a not-yet-loaded setting", async () => {
  settingsLoaded = false
  isAutostartEnabledMock.mockResolvedValueOnce(true)
  appDataDirMock.mockResolvedValueOnce("")
  getOsInfoMock.mockResolvedValueOnce({
    osType: "Linux",
    platform: "linux",
    arch: "arm64",
    version: "1",
    family: "unix",
  })
  render(<DesktopSection />)
  await screen.findByText(/Linux \(linux\)/)

  const revealButton = screen.getByRole("button", { name: "settings.desktop.revealDataDir" })
  expect(revealButton).toBeDisabled()
  expect(screen.getByTestId("browser-cookie-import-toggle")).not.toBeChecked()
  fireEvent.click(screen.getByRole("switch", { name: "settings.desktop.launchAtLoginToggle" }))
  fireEvent.click(screen.getByRole("button", { name: "settings.desktop.copyDebug" }))

  await waitFor(() => expect(setAutostartMock).toHaveBeenCalledWith(false))
  expect(writeClipboardTextMock).toHaveBeenCalledWith(expect.stringContaining("OS: Linux 1"))
  expect(writeClipboardTextMock).not.toHaveBeenCalledWith(expect.stringContaining("Locale:"))
  expect(revealInExplorerMock).not.toHaveBeenCalled()
})
