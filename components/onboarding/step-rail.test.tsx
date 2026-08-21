/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { StepProgressBar, StepRail } from "./step-rail"
import { resolveStepSequence } from "@/lib/onboarding/steps"

const seq = resolveStepSequence({ shell: "tauri", hasModelAccess: false })

describe("StepRail", () => {
  it("omits welcome — reading an intro is not setup progress", () => {
    render(<StepRail sequence={seq} current="scan" />)
    expect(screen.queryByTestId("onboarding-rail-welcome")).toBeNull()
    expect(screen.getByTestId("onboarding-rail-scan")).toBeInTheDocument()
  })

  it("marks the current step with aria-current", () => {
    render(<StepRail sequence={seq} current="provider" />)
    expect(screen.getByTestId("onboarding-rail-provider")).toHaveAttribute("aria-current", "step")
  })

  it("makes completed steps clickable and later ones inert", () => {
    const onStepChange = jest.fn()
    render(<StepRail sequence={seq} current="provider" onStepChange={onStepChange} />)
    // Backwards is always safe; forwards would skip the current step's submit.
    fireEvent.click(screen.getByTestId("onboarding-rail-scan"))
    expect(onStepChange).toHaveBeenCalledWith("scan")

    fireEvent.click(screen.getByTestId("onboarding-rail-first-run"))
    expect(onStepChange).toHaveBeenCalledTimes(1)
  })

  it("locks rail navigation while a step is busy", () => {
    const onStepChange = jest.fn()
    render(<StepRail sequence={seq} current="provider" onStepChange={onStepChange} busy />)
    fireEvent.click(screen.getByTestId("onboarding-rail-scan"))
    expect(onStepChange).not.toHaveBeenCalled()
  })

  it("carries no Back of its own — the window bar owns it at every width", () => {
    // The rail is hidden below `md`, so a Back button here needed a second
    // copy in the narrow progress bar: two controls, one behaviour.
    render(<StepRail sequence={seq} current="scan" />)
    expect(screen.queryByTestId("onboarding-rail-back")).toBeNull()
  })

  it("is a flush column, not a floating card", () => {
    render(<StepRail sequence={seq} current="scan" />)
    const rail = screen.getByTestId("onboarding-rail")
    expect(rail.className).toContain("border-r")
    expect(rail.className).not.toMatch(/\brounded-/)
    // The old rail hard-coded `dark`, which made it a black slab under a
    // light theme.
    expect(rail.className).not.toMatch(/(^|\s)dark(\s|$)/)
  })

  it("connects the steps so the list reads as one progression", () => {
    const { container } = render(<StepRail sequence={seq} current="provider" />)
    // One connector per gap — the last bullet has nothing to join to.
    const connectors = container.querySelectorAll("li span.w-px")
    expect(connectors).toHaveLength(seq.filter((s) => s.countsAsProgress).length - 1)
  })
})

describe("StepProgressBar", () => {
  it("is chrome for the column beneath it, with its own hairline", () => {
    render(<StepProgressBar sequence={seq} current="scan" />)
    const bar = screen.getByTestId("onboarding-progress-bar")
    expect(bar.className).toContain("border-b")
    expect(bar.className).toContain("md:hidden")
  })

  it("carries no Back button — the window bar above it does", () => {
    render(<StepProgressBar sequence={seq} current="scan" />)
    expect(screen.queryByTestId("onboarding-bar-back")).toBeNull()
  })

  it("names the current step", () => {
    render(<StepProgressBar sequence={seq} current="provider" />)
    expect(screen.getByText("rail.provider.label")).toBeInTheDocument()
  })

  it("renders without a label on welcome, which has no counter", () => {
    render(<StepProgressBar sequence={seq} current="welcome" />)
    expect(screen.queryByText("rail.scan.label")).toBeNull()
  })
})
