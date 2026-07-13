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

jest.mock("@/lib/tauri/autostart", () => ({
  isAutostartEnabled: jest.fn().mockResolvedValue(false),
  setAutostart: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: jest.fn().mockResolvedValue(undefined),
  revealInExplorer: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/tauri/os", () => ({
  getOsInfo: jest.fn().mockResolvedValue({
    osType: "Windows",
    platform: "windows",
    arch: "x86_64",
    version: "11",
    family: "windows",
    locale: "en-US",
    hostname: "host",
  }),
}))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn().mockResolvedValue("ok") }))
jest.mock("@tauri-apps/api/path", () => ({ appDataDir: jest.fn().mockResolvedValue("/data") }))
jest.mock("@cognia/logging", () => ({
  loggers: { app: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), message: jest.fn(), warning: jest.fn() },
}))
jest.mock("./tray-section", () => ({ TraySection: () => null }))

import { DesktopSection } from "./desktop-section"

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  getCloseBehaviorMock.mockResolvedValue("ask")
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
