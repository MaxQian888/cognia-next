/**
 * @jest-environment jsdom
 */

import type { ReactElement } from "react"
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
const mockTrackEvent = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

import { TooltipProvider } from "@/components/ui/tooltip"
import { resetKeysForSection } from "@/lib/settings/section-keys"
import { SectionResetButton } from "./section-reset-button"

/**
 * The button lives in `FeaturePageHeader`'s action slot, which mounts inside a
 * `TooltipProvider` in the real app. Rendering the tooltip trigger without one
 * throws, so every case goes through this helper.
 */
const renderButton = (ui: ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)

beforeEach(() => {
  resetMock.mockClear()
  toastSuccess.mockClear()
  mockTrackEvent.mockClear()
  localStorage.clear()
})

describe("SectionResetButton", () => {
  it("renders nothing for an unmapped (Dexie-backed) section", () => {
    const { container } = renderButton(<SectionResetButton sectionId="plugins" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders a reset button for a mapped section", () => {
    renderButton(<SectionResetButton sectionId="security" />)
    expect(screen.getByTestId("section-reset-button")).toBeInTheDocument()
  })

  it("resets the section's keys after confirming", async () => {
    const user = userEvent.setup()
    renderButton(<SectionResetButton sectionId="security" />)
    fireEvent.click(screen.getByTestId("section-reset-button"))
    await user.click(await screen.findByTestId("section-reset-confirm"))
    await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1))
    // The button's contract is "hand the section's owned keys to the store" —
    // which keys the section owns is pinned by section-keys.test.ts, so reading
    // them here keeps this from re-breaking every time a key joins a section.
    const securityKeys = resetKeysForSection("security")
    expect(securityKeys).toContain("biometricRequiredFor")
    expect(resetMock).toHaveBeenCalledWith(securityKeys)
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("keeps an accessible name while the label is collapsed in a narrow header", () => {
    // The header's action slot is `shrink-0` inside an `overflow-hidden`
    // header, so this button hides its text under `@2xl/feature-header` rather
    // than pushing the page title off the edge. Hiding the only text would
    // leave the control unnamed, so the name has to come from `aria-label`.
    renderButton(<SectionResetButton sectionId="security" />)
    const button = screen.getByTestId("section-reset-button")
    expect(button).toHaveAccessibleName("button")
    const label = button.querySelector("span")
    expect(label).not.toBeNull()
    expect(label).toHaveClass("hidden", "@2xl/feature-header:inline")
  })

  it("resets the data section's real telemetry consent", async () => {
    localStorage.setItem("cognia-behavior-telemetry-enabled", "true")
    const user = userEvent.setup()
    renderButton(<SectionResetButton sectionId="data" />)
    fireEvent.click(screen.getByTestId("section-reset-button"))
    await user.click(await screen.findByTestId("section-reset-confirm"))
    await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1))

    expect(mockTrackEvent).toHaveBeenCalledWith("telemetry.preference.changed", { enabled: false })
    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({ enabled: false })
  })

  it("restores data defaults without emitting an opt-out event when already disabled", async () => {
    const user = userEvent.setup()
    renderButton(<SectionResetButton sectionId="data" />)
    fireEvent.click(screen.getByTestId("section-reset-button"))
    await user.click(await screen.findByTestId("section-reset-confirm"))
    await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1))

    expect(mockTrackEvent).not.toHaveBeenCalled()
    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({ enabled: false })
  })
})
