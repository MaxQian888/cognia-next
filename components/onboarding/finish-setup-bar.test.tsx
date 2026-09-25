/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { AppSettings, OnboardingPath } from "@cognia/agent-config-types"
import type { SetupGap } from "@/lib/onboarding/setup-status"

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

// The live derivation has its own suite; here it is the bar's input.
const setupStatus = { gaps: [] as SetupGap[] }
const useSetupStatus = jest.fn(() => setupStatus)
jest.mock("@/hooks/onboarding/use-setup-status", () => ({
  useSetupStatus: () => useSetupStatus(),
}))

import { FinishSetupBar, SETUP_GAP_ICON, SETUP_GAP_KEY } from "./finish-setup-bar"

const SKIPPED_AT = "2026-08-01T00:00:00Z"
const withPath = (path: OnboardingPath, extra: Record<string, unknown> = {}): AppSettings =>
  ({
    id: "singleton",
    onboardingProgress: { version: 2, path, skippedAt: SKIPPED_AT, ...extra },
  }) as AppSettings

beforeEach(() => {
  jest.clearAllMocks()
  pathname = "/"
  settings = null
  setupStatus.gaps = []
})

describe("FinishSetupBar", () => {
  it("renders nothing before settings hydrate", () => {
    const { container } = render(<FinishSetupBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ["model", "gap.model"],
    ["task-failed", "gap.taskFailed"],
    ["first-task", "gap.firstTask"],
  ] as const)("names the %s gap with its own copy and action", (gap, key) => {
    settings = withPath("provider_skipped")
    setupStatus.gaps = [gap]
    render(<FinishSetupBar />)
    expect(screen.getByText(`${key}.title`)).toBeInTheDocument()
    expect(screen.getByTestId("onboarding-finish-bar-cta")).toHaveTextContent(`${key}.cta`)
    expect(screen.getByTestId("onboarding-finish-bar-cta")).toHaveAttribute("data-gap", gap)
  })

  it("names only the most blocking gap", () => {
    settings = withPath("provider_skipped")
    setupStatus.gaps = ["model", "first-task"]
    render(<FinishSetupBar />)
    expect(screen.getByText("gap.model.title")).toBeInTheDocument()
    expect(screen.queryByText("gap.firstTask.title")).toBeNull()
  })

  it("disappears once everything it was pointing at has been put right elsewhere", () => {
    // Recorded as a skipped sign-in, but a provider was configured since: the
    // live status reports nothing missing, so there is nothing to say.
    settings = withPath("provider_skipped")
    setupStatus.gaps = []
    const { container } = render(<FinishSetupBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it("does not mount the live probes for a user who finished setup", () => {
    settings = withPath("completed", { skippedAt: undefined, completedAt: SKIPPED_AT })
    const { container } = render(<FinishSetupBar />)
    expect(container).toBeEmptyDOMElement()
    expect(useSetupStatus).not.toHaveBeenCalled()
  })

  it("stays hidden for migrated legacy users so upgrades never nag", () => {
    settings = withPath("legacy_dismissed", { finishBarDismissed: true })
    setupStatus.gaps = ["model"]
    const { container } = render(<FinishSetupBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it("stays hidden once the user closed it", () => {
    settings = withPath("runtime_skipped", { finishBarDismissed: true })
    setupStatus.gaps = ["first-task"]
    const { container } = render(<FinishSetupBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it("stays hidden while the flow is still in progress", () => {
    settings = withPath("runtime_skipped", { skippedAt: undefined, lastStep: "scan" })
    setupStatus.gaps = ["model"]
    const { container } = render(<FinishSetupBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it("never renders over the flow it points at", () => {
    pathname = "/onboarding"
    settings = withPath("runtime_skipped")
    setupStatus.gaps = ["first-task"]
    const { container } = render(<FinishSetupBar />)
    expect(container).toBeEmptyDOMElement()
  })

  // Chrome-free deep links own the whole viewport. The desktop shell never
  // mounts the bar on these, but `MobileShellWrapper` drops only its tab bar
  // there — without this guard the bar painted over the pairing flow.
  it.each(["/pair", "/pair/manual", "/oauth", "/share-target", "/canvas/join/room-1"])(
    "stays off the chrome-free route %s",
    (route) => {
      pathname = route
      settings = withPath("provider_skipped")
      setupStatus.gaps = ["model"]
      const { container } = render(<FinishSetupBar />)
      expect(container).toBeEmptyDOMElement()
    }
  )

  it("routes straight to the sign-in when the model is what is missing", () => {
    settings = withPath("provider_skipped")
    setupStatus.gaps = ["model"]
    render(<FinishSetupBar />)
    fireEvent.click(screen.getByTestId("onboarding-finish-bar-cta"))
    expect(push).toHaveBeenCalledWith("/onboarding?focus=model")
  })

  it("routes straight to the first-task cards otherwise", () => {
    settings = withPath("task_failed")
    setupStatus.gaps = ["task-failed"]
    render(<FinishSetupBar />)
    fireEvent.click(screen.getByTestId("onboarding-finish-bar-cta"))
    expect(push).toHaveBeenCalledWith("/onboarding?focus=task")
  })

  it("is a live status row and flags a failed run as needing attention", () => {
    settings = withPath("task_failed")
    setupStatus.gaps = ["task-failed"]
    render(<FinishSetupBar />)
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "attention")
  })

  it("persists a permanent dismissal through a named close button", () => {
    settings = withPath("provider_skipped")
    setupStatus.gaps = ["model"]
    render(<FinishSetupBar />)
    fireEvent.click(screen.getByRole("button", { name: "dismiss" }))
    expect(dismissOnboardingFinishBar).toHaveBeenCalled()
    expect(screen.getByTestId("onboarding-finish-bar-dismiss")).toBeInTheDocument()
  })

  it("has copy and an icon for every gap the status can report", () => {
    for (const gap of ["model", "task-failed", "first-task"] as const) {
      expect(SETUP_GAP_KEY[gap]).toBeTruthy()
      expect(SETUP_GAP_ICON[gap]).toBeTruthy()
    }
  })
})
