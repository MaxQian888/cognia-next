/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { StepStepper } from "./step-stepper"
import { resolveStepSequence } from "@/lib/onboarding/steps"

const seq = resolveStepSequence({ shell: "tauri", mode: "custom", hasModelAccess: false })

describe("StepStepper", () => {
  it("numbers only the progress-bearing steps", () => {
    // Reading a product intro is not progress toward being set up, and
    // counting it makes the flow feel longer than it is.
    render(<StepStepper sequence={seq} current="scan" />)
    expect(screen.getByTestId("onboarding-rail-scan")).toBeInTheDocument()
    expect(screen.queryByTestId("onboarding-rail-welcome")).toBeNull()
  })

  it("marks the current step for assistive tech", () => {
    render(<StepStepper sequence={seq} current="provider" />)
    expect(screen.getByTestId("onboarding-rail-provider")).toHaveAttribute("aria-current", "step")
  })

  it("makes only completed steps clickable", () => {
    // Moving forward has to run the current step's submit — the scan step
    // commits a runtime choice, the sign-in step commits credentials — so
    // jumping ahead from here would skip it. Going back is always safe.
    const onStepChange = jest.fn()
    render(<StepStepper sequence={seq} current="provider" onStepChange={onStepChange} />)
    fireEvent.click(screen.getByTestId("onboarding-rail-scan"))
    expect(onStepChange).toHaveBeenCalledWith("scan")

    onStepChange.mockClear()
    fireEvent.click(screen.getByTestId("onboarding-rail-first-run"))
    expect(onStepChange).not.toHaveBeenCalled()
  })

  it("is read-only when no handler is supplied", () => {
    render(<StepStepper sequence={seq} current="provider" />)
    expect(screen.getByTestId("onboarding-rail-scan").tagName).not.toBe("BUTTON")
  })

  it("locks while a step has a request in flight", () => {
    const onStepChange = jest.fn()
    render(<StepStepper sequence={seq} current="provider" onStepChange={onStepChange} busy />)
    fireEvent.click(screen.getByTestId("onboarding-rail-scan"))
    expect(onStepChange).not.toHaveBeenCalled()
  })

  it("renders nothing when the sequence counts no progress", () => {
    // The welcome-only sequence, before the path fork is answered.
    const bare = resolveStepSequence({ shell: "tauri", mode: undefined, hasModelAccess: false })
    const { container } = render(<StepStepper sequence={bare} current="welcome" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("keeps the step ids the previous rail exposed", () => {
    // Behaviour did not change for these, so neither did the hooks the suites
    // and the e2e specs hang off.
    render(<StepStepper sequence={seq} current="scan" />)
    for (const id of ["scan", "provider", "first-run"]) {
      expect(screen.getByTestId(`onboarding-rail-${id}`)).toBeInTheDocument()
    }
  })
})
