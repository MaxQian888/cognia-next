/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const resetMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { resetSettings: typeof resetMock }) => T) =>
    selector({ resetSettings: resetMock }),
}))

const toastSuccess = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }))

import { SectionResetButton } from "./section-reset-button"

beforeEach(() => {
  resetMock.mockClear()
  toastSuccess.mockClear()
})

describe("SectionResetButton", () => {
  it("renders nothing for an unmapped section", () => {
    const { container } = render(<SectionResetButton sectionId="general" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders a reset button for a mapped section", () => {
    render(<SectionResetButton sectionId="security" />)
    expect(screen.getByTestId("section-reset-button")).toBeInTheDocument()
  })

  it("resets the section's keys after confirming", async () => {
    const user = userEvent.setup()
    render(<SectionResetButton sectionId="security" />)
    fireEvent.click(screen.getByTestId("section-reset-button"))
    await user.click(await screen.findByTestId("section-reset-confirm"))
    await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1))
    expect(resetMock).toHaveBeenCalledWith(["biometricRequiredFor"])
    expect(toastSuccess).toHaveBeenCalled()
  })
})
