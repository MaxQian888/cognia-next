import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ShareSettingsCard } from "./share-settings-card"

const getSettings = jest.fn()
const saveSettings = jest.fn()
const setShareUploadSecret = jest.fn()
const hasShareUploadSecret = jest.fn()

jest.mock("@/lib/db/settings", () => ({
  getSettings: (...a: unknown[]) => getSettings(...a),
  saveSettings: (...a: unknown[]) => saveSettings(...a),
}))
jest.mock("@/lib/share/config", () => ({
  setShareUploadSecret: (...a: unknown[]) => setShareUploadSecret(...a),
  hasShareUploadSecret: (...a: unknown[]) => hasShareUploadSecret(...a),
}))
// MySharesPanel (rendered inside the card) — stub its data deps.
jest.mock("@/lib/db/shared-links", () => ({ listSharedLinks: jest.fn().mockResolvedValue([]) }))
jest.mock("@/lib/share/client", () => ({ revokeShareLink: jest.fn() }))

beforeEach(() => {
  jest.clearAllMocks()
  getSettings.mockResolvedValue({ shareUrl: "https://existing.test" })
  hasShareUploadSecret.mockResolvedValue(false)
  saveSettings.mockResolvedValue({})
  setShareUploadSecret.mockResolvedValue(undefined)
})

describe("ShareSettingsCard", () => {
  it("loads the existing url", async () => {
    render(<ShareSettingsCard />)
    await waitFor(() =>
      expect(screen.getByLabelText("Share worker URL")).toHaveValue("https://existing.test")
    )
  })

  it("saves the url and a newly-typed secret", async () => {
    render(<ShareSettingsCard />)
    await waitFor(() => expect(getSettings).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText("Share worker URL"), {
      target: { value: "https://new.test" },
    })
    fireEvent.change(screen.getByLabelText("Upload secret"), { target: { value: "topsecret" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ shareUrl: "https://new.test" }))
    expect(setShareUploadSecret).toHaveBeenCalledWith("topsecret")
  })

  it("does not write the secret when the field is left empty", async () => {
    render(<ShareSettingsCard />)
    await waitFor(() => expect(getSettings).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(setShareUploadSecret).not.toHaveBeenCalled()
  })

  it("offers to clear an existing secret", async () => {
    hasShareUploadSecret.mockResolvedValue(true)
    render(<ShareSettingsCard />)
    const clearBtn = await screen.findByRole("button", { name: "Clear" })
    fireEvent.click(clearBtn)
    await waitFor(() => expect(setShareUploadSecret).toHaveBeenCalledWith(""))
  })
})
