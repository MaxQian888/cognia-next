/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ExpressStep, type ExpressStepProps } from "./express-step"
import type { ExpressPlanItem } from "@/lib/onboarding/express-plan"

const RICH: ExpressPlanItem[] = [
  {
    id: "migrate-claude-code",
    kind: "migrate-config",
    vendor: "claude-code",
    label: "Claude Code",
    selected: true,
    required: false,
  },
  { id: "history", kind: "import-history", count: 128, selected: true, required: false },
  { id: "runtime", kind: "use-runtime", label: "Claude Code", selected: true, required: true },
  {
    id: "capabilities",
    kind: "capabilities",
    capabilities: ["fs", "web"],
    count: 2,
    selected: true,
    required: true,
  },
]

const FRESH: ExpressPlanItem[] = [
  { id: "sign-in", kind: "sign-in", selected: true, required: true },
  {
    id: "capabilities",
    kind: "capabilities",
    capabilities: ["web"],
    count: 1,
    selected: true,
    required: true,
  },
]

const renderStep = (props: Partial<ExpressStepProps> = {}) =>
  render(
    <ExpressStep
      items={RICH}
      phase="plan"
      modelAccess
      dropped={new Set()}
      onToggle={jest.fn()}
      onApply={jest.fn()}
      {...props}
    />
  )

describe("ExpressStep — the plan", () => {
  it("lists every line the plan carries", () => {
    renderStep()
    for (const item of RICH) {
      expect(screen.getByTestId(`onboarding-express-item-${item.id}`)).toBeInTheDocument()
    }
  })

  it("gives a checkbox only to lines that actually do something", () => {
    // A statement of fact has nothing to decide: unchecking "we will use your
    // signed-in Claude Code" would not mean "do less", it would mean "now ask
    // me to sign in again".
    renderStep()
    expect(screen.getByTestId("onboarding-express-toggle-migrate-claude-code")).toBeInTheDocument()
    expect(screen.getByTestId("onboarding-express-toggle-history")).toBeInTheDocument()
    expect(screen.queryByTestId("onboarding-express-toggle-runtime")).toBeNull()
    expect(screen.queryByTestId("onboarding-express-toggle-capabilities")).toBeNull()
  })

  it("reports a drop upward rather than keeping it to itself", () => {
    // The narrative panel's scene draws the same selection; a copy in each
    // would let the picture and the list disagree about what will run.
    const onToggle = jest.fn()
    renderStep({ onToggle })
    fireEvent.click(screen.getByTestId("onboarding-express-toggle-history"))
    expect(onToggle).toHaveBeenCalledWith("history")
  })

  it("shows a dropped line as dropped", () => {
    renderStep({ dropped: new Set(["history"]) })
    expect(screen.getByTestId("onboarding-express-item-history")).toHaveAttribute(
      "data-dropped",
      "true"
    )
  })

  it("cannot drop a required line however the host is asked", () => {
    renderStep({ dropped: new Set(["runtime"]) })
    expect(screen.getByTestId("onboarding-express-item-runtime")).toHaveAttribute(
      "data-dropped",
      "false"
    )
  })

  it("runs nothing until the button is pressed", () => {
    const onApply = jest.fn()
    renderStep({ onApply })
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("onboarding-express-apply"))
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it("adapts its heading and subtitle to a machine with nothing on it", () => {
    // "Here is what we will bring over — uncheck anything you would rather
    // skip" is two lies when there is nothing to bring and nothing to uncheck.
    renderStep({ items: FRESH, modelAccess: false })
    expect(screen.getByRole("heading")).toHaveTextContent("express.freshTitle")
    expect(screen.getByText("express.freshDescription")).toBeInTheDocument()
  })

  it("blocks the run until the sign-in line is satisfied, and says why", () => {
    renderStep({ items: FRESH, modelAccess: false })
    expect(screen.getByTestId("onboarding-express-apply")).toBeDisabled()
    expect(screen.getByTestId("onboarding-express-blocked")).toHaveTextContent("express.needsModel")
  })

  it("releases as soon as a credential lands on this very screen", () => {
    renderStep({ items: FRESH, modelAccess: true })
    expect(screen.getByTestId("onboarding-express-apply")).toBeEnabled()
  })

  it("hosts the sign-in surface under its own line, not on a screen of its own", () => {
    renderStep({
      items: FRESH,
      modelAccess: false,
      signIn: <div data-testid="test-sign-in" />,
    })
    expect(screen.getByTestId("test-sign-in")).toBeInTheDocument()
  })

  it("names pairing rather than sign-in when that is what is missing", () => {
    const paired: ExpressPlanItem[] = [
      { id: "pair", kind: "pair", selected: true, required: true },
      {
        id: "capabilities",
        kind: "capabilities",
        capabilities: ["web"],
        selected: true,
        required: true,
      },
    ]
    renderStep({ items: paired, modelAccess: null, paired: false })
    expect(screen.getByTestId("onboarding-express-apply")).toBeDisabled()
    expect(screen.getByTestId("onboarding-express-blocked")).toHaveTextContent(
      "express.needsPairing"
    )
  })
})

describe("ExpressStep — applying", () => {
  it("locks the checkboxes while the plan runs", () => {
    renderStep({ phase: "applying" })
    expect(screen.queryByTestId("onboarding-express-toggle-history")).toBeNull()
  })

  it("hides the button so the plan cannot be started twice", () => {
    renderStep({ phase: "applying" })
    expect(screen.queryByTestId("onboarding-express-apply")).toBeNull()
  })

  it("carries each line's own progress", () => {
    renderStep({
      phase: "applying",
      status: { "migrate-claude-code": "done", history: "running" },
    })
    expect(screen.getByTestId("onboarding-express-item-migrate-claude-code")).toHaveAttribute(
      "data-status",
      "done"
    )
    expect(screen.getByTestId("onboarding-express-item-history")).toHaveAttribute(
      "data-status",
      "running"
    )
    expect(screen.getByTestId("onboarding-express-item-runtime")).toHaveAttribute(
      "data-status",
      "queued"
    )
  })

  it("switches the heading, since the plan is no longer a proposal", () => {
    renderStep({ phase: "applying" })
    expect(screen.getByRole("heading")).toHaveTextContent("express.applyingTitle")
  })

  it("takes the sign-in surface away once there is nothing to sign in for", () => {
    renderStep({
      items: FRESH,
      phase: "applying",
      signIn: <div data-testid="test-sign-in" />,
    })
    expect(screen.queryByTestId("test-sign-in")).toBeNull()
  })
})

describe("ExpressStep — ready", () => {
  it("hands over to the terminal step in place rather than navigating", () => {
    // That is what makes this two screens end to end rather than four.
    renderStep({ phase: "ready", children: <div data-testid="test-first-run" /> })
    expect(screen.getByTestId("onboarding-express-ready")).toBeInTheDocument()
    expect(screen.getByTestId("test-first-run")).toBeInTheDocument()
    expect(screen.queryByTestId("onboarding-express-list")).toBeNull()
  })
})
