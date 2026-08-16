/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/onboarding/capability-tour", () => ({
  CapabilityTour: () => <div data-testid="capability-tour" />,
}))

import { OnboardingSettingsCard } from "./onboarding-settings-card"

beforeEach(() => jest.clearAllMocks())

describe("OnboardingSettingsCard", () => {
  it("offers the re-entry the migration promises to legacy users", () => {
    // Without this, marking someone `legacy_dismissed` would mean deciding for
    // them with no way back.
    render(<OnboardingSettingsCard />)
    fireEvent.click(screen.getByTestId("settings-onboarding-restart"))
    expect(push).toHaveBeenCalledWith("/onboarding")
  })

  it("hosts the capability tour now that it is off the critical path", () => {
    render(<OnboardingSettingsCard />)
    expect(screen.getByTestId("capability-tour")).toBeInTheDocument()
  })
})
