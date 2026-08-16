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

  it("hides Back when no handler is supplied", () => {
    render(<StepRail sequence={seq} current="scan" />)
    expect(screen.queryByTestId("onboarding-rail-back")).toBeNull()
  })

  it("wires Back when supplied", () => {
    const onBack = jest.fn()
    render(<StepRail sequence={seq} current="scan" onBack={onBack} />)
    fireEvent.click(screen.getByTestId("onboarding-rail-back"))
    expect(onBack).toHaveBeenCalled()
  })
})

describe("StepProgressBar", () => {
  it("carries its own Back button — the rail is hidden at these widths", () => {
    const onBack = jest.fn()
    render(<StepProgressBar sequence={seq} current="scan" onBack={onBack} />)
    fireEvent.click(screen.getByTestId("onboarding-bar-back"))
    expect(onBack).toHaveBeenCalled()
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
