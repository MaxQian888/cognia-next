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

import { toast } from "sonner"
import { UpdateCard } from "./update-card"

const toastMock = toast as unknown as {
  success: jest.Mock
  error: jest.Mock
  info: jest.Mock
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
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
})
