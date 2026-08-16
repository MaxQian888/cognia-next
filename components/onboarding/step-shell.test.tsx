/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { StepHeading, StepShell } from "./step-shell"
import { resolveStepSequence } from "@/lib/onboarding/steps"

const seq = resolveStepSequence({ shell: "tauri", hasModelAccess: false })

describe("StepShell", () => {
  it("renders the step body inside one persistent shell", () => {
    render(
      <StepShell sequence={seq} current="scan">
        <p>body</p>
      </StepShell>
    )
    expect(screen.getByTestId("onboarding-shell")).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()
  })

  it("fills its parent slot instead of the viewport so the desktop chrome (rail, title/status bars) is respected", () => {
    render(
      <StepShell sequence={seq} current="scan">
        <p>body</p>
      </StepShell>
    )
    const shell = screen.getByTestId("onboarding-shell")
    // `DesktopAppShell` mounts routes inside a flex row between the title bar,
    // guild rail and status bar. A viewport-height shell overflowed that slot
    // and pushed the sticky footer under the status bar.
    expect(shell.className).toContain("h-full")
    expect(shell.className).toContain("flex-1")
    expect(shell.className).toContain("min-h-0")
    expect(shell.className).not.toMatch(/\bh-\[100dvh\]|\bh-screen|\bh-dvh/)
  })

  it("replays the body entrance on each step change while the shell itself stays mounted", () => {
    const { rerender } = render(
      <StepShell sequence={seq} current="scan">
        <p>scan body</p>
      </StepShell>
    )
    const shell = screen.getByTestId("onboarding-shell")
    const firstBody = screen.getByTestId("onboarding-step-body")
    expect(shell.className).toContain("animate-in")
    expect(firstBody.className).toContain("animate-in")
    expect(firstBody.className).toContain("fade-in")

    rerender(
      <StepShell sequence={seq} current="provider">
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

  it("renders both rail and narrow progress bar so one is always available", () => {
    render(
      <StepShell sequence={seq} current="scan" onBack={jest.fn()}>
        <p>body</p>
      </StepShell>
    )
    expect(screen.getByTestId("onboarding-rail-back")).toBeInTheDocument()
    expect(screen.getByTestId("onboarding-bar-back")).toBeInTheDocument()
  })

  it("omits the footer region entirely when no footer is given", () => {
    const { container } = render(
      <StepShell sequence={seq} current="welcome">
        <p>body</p>
      </StepShell>
    )
    expect(container.querySelector("footer")).toBeNull()
  })

  it("renders footer actions when supplied", () => {
    render(
      <StepShell sequence={seq} current="scan" footer={<button>skip</button>}>
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
