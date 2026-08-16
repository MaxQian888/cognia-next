/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { AppSettings, OnboardingPath } from "@cognia/agent-config-types"

const push = jest.fn()
let pathname = "/"
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
}))

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const dismissOnboardingFinishBar = jest.fn().mockResolvedValue(undefined)
let settings: AppSettings | null = null
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ settings, dismissOnboardingFinishBar }),
}))

import { FinishSetupBar } from "./finish-setup-bar"

const withPath = (path: OnboardingPath, extra: Record<string, unknown> = {}): AppSettings =>
  ({ id: "singleton", onboardingProgress: { version: 1, path, ...extra } }) as AppSettings

beforeEach(() => {
  jest.clearAllMocks()
  pathname = "/"
  settings = null
})

describe("FinishSetupBar", () => {
  it("renders nothing before settings hydrate", () => {
    const { container } = render(<FinishSetupBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each(["provider_skipped", "runtime_skipped", "task_failed"] as const)(
    "names what is missing for the %s exit",
    (path) => {
      settings = withPath(path)
      render(<FinishSetupBar />)
      // Naming the specific gap is only possible because the exit path is
      // recorded — the timestamp this replaces could not have.
      expect(screen.getByText(path)).toBeInTheDocument()
    }
  )

  it("stays hidden after a completed run", () => {
    settings = withPath("completed", { completedAt: "2026-08-01T00:00:00Z" })
    const { container } = render(<FinishSetupBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it("stays hidden for migrated legacy users so upgrades never nag", () => {
    settings = withPath("legacy_dismissed", { finishBarDismissed: true })
    const { container } = render(<FinishSetupBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it("stays hidden once the user closed it", () => {
    settings = withPath("runtime_skipped", { finishBarDismissed: true })
    const { container } = render(<FinishSetupBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it("never renders over the flow it points at", () => {
    pathname = "/onboarding"
    settings = withPath("runtime_skipped")
    const { container } = render(<FinishSetupBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it("routes back into the flow", () => {
    settings = withPath("provider_skipped")
    render(<FinishSetupBar />)
    fireEvent.click(screen.getByTestId("onboarding-finish-bar-cta"))
    expect(push).toHaveBeenCalledWith("/onboarding")
  })

  it("persists a permanent dismissal", () => {
    settings = withPath("provider_skipped")
    render(<FinishSetupBar />)
    fireEvent.click(screen.getByTestId("onboarding-finish-bar-dismiss"))
    expect(dismissOnboardingFinishBar).toHaveBeenCalled()
  })
})
