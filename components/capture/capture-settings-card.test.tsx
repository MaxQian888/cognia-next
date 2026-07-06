import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CaptureSettingsCard } from "./capture-settings-card"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { toast } from "sonner"

jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(), saveSettings: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mockGet = getSettings as jest.Mock
const mockSave = saveSettings as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockGet.mockResolvedValue({})
  mockSave.mockResolvedValue(undefined)
})

describe("CaptureSettingsCard", () => {
  it("renders and saves settings", async () => {
    render(<CaptureSettingsCard />)
    expect(await screen.findByText("Content capture")).toBeInTheDocument()
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
    render(<CaptureSettingsCard />)
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    expect(await screen.findByDisplayValue("3000")).toBeInTheDocument()
  })
})
