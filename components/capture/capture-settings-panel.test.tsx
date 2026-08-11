import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

import { getSettings, saveSettings } from "@/lib/db/settings"
import { CaptureSettingsPanel } from "./capture-settings-panel"

jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(), saveSettings: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mockGet = getSettings as jest.Mock
const mockSave = saveSettings as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockGet.mockResolvedValue({})
  mockSave.mockResolvedValue(undefined)
})

describe("CaptureSettingsPanel", () => {
  it("renders a flat settings block and saves settings", async () => {
    render(<CaptureSettingsPanel />)
    expect(await screen.findByText("Content capture")).toBeInTheDocument()
    expect(screen.queryByTestId("card")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("capture-settings-save"))
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith({ capture: expect.any(Object) }))
    expect(toast.success).toHaveBeenCalled()
  })

  it("hydrates from persisted settings", async () => {
    mockGet.mockResolvedValue({
      capture: {
        enabled: true,
        mode: "silent",
        pollIntervalMs: 3000,
        confirmTimeoutSec: 5,
        privacyMode: false,
      },
    })
    render(<CaptureSettingsPanel />)
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    expect(await screen.findByDisplayValue("3000")).toBeInTheDocument()
  })

  it("surfaces save errors without losing the editable state", async () => {
    mockSave.mockRejectedValue(new Error("save failed"))
    render(<CaptureSettingsPanel />)
    await userEvent.click(await screen.findByTestId("capture-settings-save"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("save failed"))
    expect(screen.getByRole("spinbutton", { name: "Poll interval (ms)" })).toBeEnabled()
  })
})
