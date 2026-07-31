/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

const runMock = jest.fn()
const clearErrorMock = jest.fn()
let mockBusy = false
let mockError: string | null = null
jest.mock("@/hooks/skills", () => ({
  URL_INSTALL_INVALID: "invalid",
  useUrlInstall: () => ({
    run: runMock,
    busy: mockBusy,
    error: mockError,
    clearError: clearErrorMock,
  }),
}))

let mockOpen = true
const setOpenMock = jest.fn()
jest.mock("@/stores/skills/skills-store", () => ({
  useSkillsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ urlInstallOpen: mockOpen, setUrlInstallOpen: setOpenMock }),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { SkillUrlInstallDialog } from "./skill-url-install-dialog"

beforeEach(() => {
  jest.clearAllMocks()
  mockOpen = true
  mockBusy = false
  mockError = null
})

describe("SkillUrlInstallDialog", () => {
  it("renders nothing when closed", () => {
    mockOpen = false
    render(<SkillUrlInstallDialog />)
    expect(screen.queryByTestId("skill-url-install-input")).not.toBeInTheDocument()
  })

  it("runs the install and closes with a success toast", async () => {
    runMock.mockResolvedValue({ name: "find-skills", sourceId: "o/r/s" })
    render(<SkillUrlInstallDialog />)
    fireEvent.change(screen.getByTestId("skill-url-install-input"), {
      target: { value: "o/r/s" },
    })
    fireEvent.click(screen.getByText("install"))
    await waitFor(() => expect(runMock).toHaveBeenCalledWith("o/r/s"))
    expect(toast.success).toHaveBeenCalledWith('installed:{"name":"find-skills"}')
    expect(setOpenMock).toHaveBeenCalledWith(false)
  })

  it("submits on Enter", async () => {
    runMock.mockResolvedValue({ name: "x", sourceId: "o/r/s" })
    render(<SkillUrlInstallDialog />)
    const input = screen.getByTestId("skill-url-install-input")
    fireEvent.change(input, { target: { value: "o/r/s" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(runMock).toHaveBeenCalledWith("o/r/s"))
  })

  it("renders the localized invalid-input error", () => {
    mockError = "invalid"
    render(<SkillUrlInstallDialog />)
    expect(screen.getByTestId("skill-url-install-error")).toHaveTextContent("errorInvalid")
  })

  it("renders resolver errors verbatim and stays open on failure", async () => {
    mockError = "No skill found at o/r/r"
    runMock.mockRejectedValue(new Error("No skill found at o/r/r"))
    render(<SkillUrlInstallDialog />)
    expect(screen.getByTestId("skill-url-install-error")).toHaveTextContent("No skill found")
    fireEvent.change(screen.getByTestId("skill-url-install-input"), {
      target: { value: "o/r" },
    })
    fireEvent.click(screen.getByText("install"))
    await waitFor(() => expect(runMock).toHaveBeenCalled())
    expect(setOpenMock).not.toHaveBeenCalledWith(false)
  })

  it("disables the install button while busy or empty", () => {
    mockBusy = true
    render(<SkillUrlInstallDialog />)
    expect(screen.getByText("installing").closest("button")).toBeDisabled()
  })
})
