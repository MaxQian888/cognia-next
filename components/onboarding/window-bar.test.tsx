/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const chromeMode = { value: "none" as "none" | "traffic-lights" | "buttons" }
jest.mock("@/components/desktop/window-controls", () => ({
  useWindowChromeMode: () => chromeMode.value,
  WindowControls: () => <div data-testid="window-controls" />,
}))

import { OnboardingWindowBar } from "./window-bar"

beforeEach(() => {
  chromeMode.value = "none"
})

describe("OnboardingWindowBar", () => {
  it("renders the wordmark and mounts the window controls", () => {
    render(<OnboardingWindowBar />)
    expect(screen.getByTestId("onboarding-window-bar")).toBeInTheDocument()
    expect(screen.getByText("wordmark")).toBeInTheDocument()
    // Mounted unconditionally — the component decides per platform.
    expect(screen.getByTestId("window-controls")).toBeInTheDocument()
  })

  it("is the whole flow's drag region, since the desktop title bar is suppressed here", () => {
    render(<OnboardingWindowBar />)
    expect(screen.getByTestId("onboarding-window-bar")).toHaveAttribute("data-tauri-drag-region")
  })

  it("reserves room for the macOS traffic lights instead of drawing under them", () => {
    chromeMode.value = "traffic-lights"
    render(<OnboardingWindowBar />)
    expect(screen.getByTestId("onboarding-window-bar")).toHaveClass("pl-20")
  })

  it("keeps the leading edge tight where the OS draws nothing", () => {
    chromeMode.value = "buttons"
    render(<OnboardingWindowBar />)
    const bar = screen.getByTestId("onboarding-window-bar")
    expect(bar).toHaveClass("pl-3")
    expect(bar).not.toHaveClass("pl-20")
  })

  it("paints no tint or border — the flow is the content, not a framed page", () => {
    render(<OnboardingWindowBar />)
    const bar = screen.getByTestId("onboarding-window-bar")
    expect(bar.className).not.toMatch(/\bbg-|\bborder-b\b/)
  })

  it("hides Back on the first step, where there is nowhere to go", () => {
    render(<OnboardingWindowBar />)
    expect(screen.queryByTestId("onboarding-back")).toBeNull()
  })

  it("wires Back when a handler is supplied", () => {
    const onBack = jest.fn()
    render(<OnboardingWindowBar onBack={onBack} />)
    fireEvent.click(screen.getByTestId("onboarding-back"))
    expect(onBack).toHaveBeenCalled()
  })

  it("locks Back while a step is busy", () => {
    const onBack = jest.fn()
    render(<OnboardingWindowBar onBack={onBack} busy />)
    expect(screen.getByTestId("onboarding-back")).toBeDisabled()
  })
})
