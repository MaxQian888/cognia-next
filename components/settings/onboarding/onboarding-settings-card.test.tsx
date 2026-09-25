/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { SetupGap } from "@/lib/onboarding/setup-status"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/onboarding/capability-tour", () => ({
  CapabilityTour: () => <div data-testid="capability-tour" />,
}))

const setupStatus = { gaps: [] as SetupGap[] }
jest.mock("@/hooks/onboarding/use-setup-status", () => ({
  useSetupStatus: () => setupStatus,
}))

import { OnboardingSettingsCard } from "./onboarding-settings-card"

beforeEach(() => {
  jest.clearAllMocks()
  setupStatus.gaps = []
})

describe("OnboardingSettingsCard", () => {
  it("offers the re-entry the migration promises to legacy users", () => {
    // Without this, marking someone `legacy_dismissed` would mean deciding for
    // them with no way back.
    render(<OnboardingSettingsCard />)
    fireEvent.click(screen.getByTestId("settings-onboarding-restart"))
    expect(push).toHaveBeenCalledWith("/onboarding")
  })

  it("says so when nothing is missing", () => {
    render(<OnboardingSettingsCard />)
    expect(screen.getByTestId("settings-onboarding-status")).toHaveTextContent(
      "setupStatus.complete.title"
    )
    expect(screen.queryByTestId("settings-onboarding-resume")).toBeNull()
  })

  it("names the most blocking gap in the same words as the finish-setup bar", () => {
    setupStatus.gaps = ["model", "first-task"]
    render(<OnboardingSettingsCard />)
    const status = screen.getByTestId("settings-onboarding-status")
    expect(status).toHaveTextContent("finishBar.gap.model.title")
    expect(status).not.toHaveTextContent("finishBar.gap.firstTask.title")
  })

  it("goes straight to what is missing, and still offers the full re-run", () => {
    setupStatus.gaps = ["first-task"]
    render(<OnboardingSettingsCard />)
    fireEvent.click(screen.getByTestId("settings-onboarding-resume"))
    expect(push).toHaveBeenCalledWith("/onboarding?focus=task")
    fireEvent.click(screen.getByTestId("settings-onboarding-restart"))
    expect(push).toHaveBeenLastCalledWith("/onboarding")
  })

  it("flags a failed first run as needing attention", () => {
    setupStatus.gaps = ["task-failed"]
    render(<OnboardingSettingsCard />)
    expect(screen.getByTestId("settings-onboarding-status")).toHaveAttribute(
      "data-tone",
      "attention"
    )
  })

  it("hosts the capability tour now that it is off the critical path", () => {
    render(<OnboardingSettingsCard />)
    expect(screen.getByTestId("capability-tour")).toBeInTheDocument()
  })
})
