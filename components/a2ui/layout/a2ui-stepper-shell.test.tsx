/**
 * Tests for A2UIStepperShell.
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { A2UIStepperShell } from "./a2ui-stepper-shell"
import type { A2UIComponentProps, A2UIStepperShellComponent } from "@/types/a2ui/schema"

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      {node}
    </NextIntlClientProvider>
  )
}

function makeProps(
  overrides: Partial<A2UIStepperShellComponent> & { dataModel?: Record<string, unknown> } = {}
): A2UIComponentProps<A2UIStepperShellComponent> {
  const component: A2UIStepperShellComponent = {
    id: "stepper-1",
    component: "StepperShell",
    title: overrides.title,
    description: overrides.description,
    steps: overrides.steps ?? [],
    currentStep: overrides.currentStep,
    currentStepPath: overrides.currentStepPath,
    stepChangeAction: overrides.stepChangeAction,
    actionMeta: overrides.actionMeta,
    previousLabel: overrides.previousLabel,
    nextLabel: overrides.nextLabel,
  }
  return {
    component,
    surfaceId: "surface-1",
    dataModel: overrides.dataModel ?? {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(() => null),
  }
}

describe("A2UIStepperShell", () => {
  it("renders the i18n empty state when no steps are bound", () => {
    render(withIntl(<A2UIStepperShell {...makeProps()} />))
    expect(screen.getByText(/no steps are available/i)).toBeInTheDocument()
  })

  it("renders the active step's title and description", () => {
    const props = makeProps({
      title: "Roadmap",
      description: "Multi-step task",
      steps: [
        { id: "step-1", title: "Plan", description: "Start here." },
        { id: "step-2", title: "Build", description: "Continue here." },
      ],
    })
    render(withIntl(<A2UIStepperShell {...props} />))
    expect(screen.getByText("Roadmap")).toBeInTheDocument()
    expect(screen.getByText("Plan")).toBeInTheDocument()
    expect(screen.getByText("Multi-step task")).toBeInTheDocument()
    expect(screen.getByText("Start here.")).toBeInTheDocument()
  })

  it("advances to next step on Next click, firing data + action callbacks", () => {
    const props = makeProps({
      steps: [
        { id: "step-1", title: "Plan", description: "Start here." },
        { id: "step-2", title: "Build", description: "Continue here." },
      ],
      currentStep: { path: "/stepIndex" },
      currentStepPath: "/stepIndex",
      stepChangeAction: "step_changed",
      dataModel: { stepIndex: 0 },
    })
    render(withIntl(<A2UIStepperShell {...props} />))
    fireEvent.click(screen.getByRole("button", { name: /Next/i }))
    expect(props.onDataChange).toHaveBeenCalledWith("/stepIndex", 1)
    expect(props.onAction).toHaveBeenCalledWith("step_changed", {
      stepId: "step-2",
      stepIndex: 1,
    })
  })

  it("uses caller-provided previousLabel / nextLabel overrides", () => {
    const props = makeProps({
      steps: [
        { id: "s1", title: "One" },
        { id: "s2", title: "Two" },
      ],
      previousLabel: "Back",
      nextLabel: "Forward",
    })
    render(withIntl(<A2UIStepperShell {...props} />))
    expect(screen.getByRole("button", { name: /Back/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Forward/i })).toBeInTheDocument()
  })

  it("clamps currentStep into range", () => {
    const props = makeProps({
      steps: [{ id: "s1", title: "Only step" }],
      currentStep: 99, // out of range
    })
    render(withIntl(<A2UIStepperShell {...props} />))
    expect(screen.getByText("Only step")).toBeInTheDocument()
  })

  it("disables the Previous button on the first step", () => {
    const props = makeProps({
      steps: [
        { id: "s1", title: "One" },
        { id: "s2", title: "Two" },
      ],
      currentStep: 0,
    })
    render(withIntl(<A2UIStepperShell {...props} />))
    const prev = screen.getByRole("button", { name: /Previous/i })
    expect(prev).toBeDisabled()
  })
})
