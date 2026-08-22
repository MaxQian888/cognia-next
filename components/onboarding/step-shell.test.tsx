/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/desktop/window-controls", () => ({
  useWindowChromeMode: () => "none",
  WindowControls: () => null,
}))

import { StepHeading, StepShell } from "./step-shell"
import { resolveStepSequence } from "@/lib/onboarding/steps"

const seq = resolveStepSequence({ shell: "tauri", mode: "custom", hasModelAccess: false })
const expressSeq = resolveStepSequence({
  shell: "tauri",
  mode: "express",
  hasModelAccess: false,
})

/** Every case needs a scene; none of them is about which one. */
const scene = <svg data-testid="test-scene" />

describe("StepShell", () => {
  it("renders the step body inside one persistent shell", () => {
    render(
      <StepShell sequence={seq} current="scan" scene={scene}>
        <p>body</p>
      </StepShell>
    )
    expect(screen.getByTestId("onboarding-shell")).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()
  })

  it("owns the whole window — the desktop chrome is suppressed on this route", () => {
    render(
      <StepShell sequence={seq} current="scan" scene={scene}>
        <p>body</p>
      </StepShell>
    )
    const shell = screen.getByTestId("onboarding-shell")
    // `isOnboardingRoute` makes `DesktopAppShell` render bare children here, so
    // nothing above supplies a height: the flow has to be the viewport itself.
    expect(shell.className).toContain("h-[100dvh]")
    expect(shell.className).toContain("overflow-hidden")
    // Still a flex child on mobile, where the wrapper hands it a definite
    // column — flex-basis governs there, so one class list serves both.
    expect(shell.className).toContain("flex-1")
    expect(shell.className).toContain("min-h-0")
  })

  it("draws its own window bar, since the title bar that carried the drag region is gone", () => {
    render(
      <StepShell sequence={seq} current="scan" scene={scene}>
        <p>body</p>
      </StepShell>
    )
    expect(screen.getByTestId("onboarding-window-bar")).toBeInTheDocument()
  })

  it("keeps every edge square — radii belong to the cards inside, not the window", () => {
    render(
      <StepShell sequence={seq} current="scan" scene={scene} footer={<button>skip</button>}>
        <p>body</p>
      </StepShell>
    )
    expect(screen.getByTestId("onboarding-shell").className).not.toMatch(/\brounded-/)
    expect(screen.getByTestId("onboarding-narrative-panel").className).not.toMatch(/\brounded-/)
    expect(screen.getByTestId("onboarding-actions").className).not.toMatch(/\brounded-/)
  })

  it("replays the body entrance on each step change while the shell itself stays mounted", () => {
    const { rerender } = render(
      <StepShell sequence={seq} current="scan" scene={scene}>
        <p>scan body</p>
      </StepShell>
    )
    const shell = screen.getByTestId("onboarding-shell")
    const firstBody = screen.getByTestId("onboarding-step-body")
    expect(shell.className).toContain("animate-in")
    expect(firstBody.className).toContain("animate-in")
    expect(firstBody.className).toContain("fade-in")

    rerender(
      <StepShell sequence={seq} current="provider" scene={scene}>
        <p>provider body</p>
      </StepShell>
    )
    // Same shell node (no full-window re-fade) …
    expect(screen.getByTestId("onboarding-shell")).toBe(shell)
    // … but a fresh body node, so its `animate-in` entrance runs again.
    const secondBody = screen.getByTestId("onboarding-step-body")
    expect(secondBody).not.toBe(firstBody)
    expect(secondBody).toHaveTextContent("provider body")
  })

  it("renders one narrative panel at every width, not a rail plus a stand-in", () => {
    render(
      <StepShell sequence={seq} current="scan" scene={scene}>
        <p>body</p>
      </StepShell>
    )
    // The panel exists at every width — it becomes a band across the top below
    // `md` rather than being swapped for a separate progress bar, so there is
    // exactly one of each and no second copy to keep in step.
    expect(screen.getAllByTestId("onboarding-narrative-panel")).toHaveLength(1)
    expect(screen.getAllByTestId("onboarding-stepper")).toHaveLength(1)
    expect(screen.queryByTestId("onboarding-progress-bar")).toBeNull()
  })

  it("renders the step's scene into the panel", () => {
    render(
      <StepShell sequence={seq} current="scan" scene={scene}>
        <p>body</p>
      </StepShell>
    )
    expect(screen.getByTestId("test-scene")).toBeInTheDocument()
  })

  it("hides the stepper on the recommended path", () => {
    // Its sequence is two screens, one of which is the intro; a progress row
    // reading "1 of 1" says nothing except "you took the short path".
    render(
      <StepShell sequence={expressSeq} current="express" scene={scene} showStepper={false}>
        <p>body</p>
      </StepShell>
    )
    expect(screen.queryByTestId("onboarding-stepper")).toBeNull()
    // The scene still renders — that is where the recommended path's progress
    // actually shows.
    expect(screen.getByTestId("test-scene")).toBeInTheDocument()
  })

  it("routes Back to the window bar, which exists at every width", () => {
    const onBack = jest.fn()
    render(
      <StepShell sequence={seq} current="scan" scene={scene} onBack={onBack}>
        <p>body</p>
      </StepShell>
    )
    // One control, not one per breakpoint — the window bar exists at every width.
    expect(screen.getAllByTestId("onboarding-back")).toHaveLength(1)
    expect(onBack).not.toHaveBeenCalled()
  })

  it("omits the footer region entirely when no footer is given", () => {
    const { container } = render(
      <StepShell sequence={seq} current="welcome" scene={scene}>
        <p>body</p>
      </StepShell>
    )
    expect(container.querySelector("footer")).toBeNull()
  })

  it("renders footer actions when supplied", () => {
    render(
      <StepShell sequence={seq} current="scan" scene={scene} footer={<button>skip</button>}>
        <p>body</p>
      </StepShell>
    )
    expect(screen.getByRole("button", { name: "skip" })).toBeInTheDocument()
  })
})

describe("StepHeading", () => {
  it("renders the title as the page heading", () => {
    render(<StepHeading title="Scan" />)
    expect(screen.getByRole("heading", { name: "Scan" })).toBeInTheDocument()
  })

  it("omits the description paragraph when absent", () => {
    const { container } = render(<StepHeading title="Scan" />)
    expect(container.querySelectorAll("p")).toHaveLength(0)
  })

  it("renders the description when given", () => {
    render(<StepHeading title="Scan" description="what we found" />)
    expect(screen.getByText("what we found")).toBeInTheDocument()
  })
})
