/**
 * @jest-environment jsdom
 */

/**
 * Tests for the AI Shell plan view component.
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { AiShellPlanView } from "./ai-shell-plan-view"
import type { ExecutionPlan, ErrorAdvisory } from "@/lib/terminal/ai-shell"

const messages = {
  terminal: {
    aiShell: {
      plan: {
        title: "Execution Plan",
        empty: "No steps generated.",
        generating: "Generating plan…",
        ready: "Plan ready — review and run.",
        executing: "Executing…",
        completed: "All steps completed.",
        cancelled: "Plan cancelled.",
        error: "Failed to generate plan.",
      },
      step: {
        pending: "Pending",
        running: "Running…",
        succeeded: "Done",
        failed: "Failed (exit {code})",
        failedNoCode: "Failed",
        skipped: "Skipped",
        cancelled: "Cancelled",
        confirm: "This step may be destructive. Run it?",
        edit: "Edit command",
        skip: "Skip step",
        retry: "Retry step",
      },
      actions: {
        runAll: "Run all",
        stepByStep: "Step by step",
        cancel: "Cancel",
        stop: "Stop execution",
        newPlan: "New plan",
      },
      error: { advisory: "Diagnosis" },
      advisory: {
        title: "Error Diagnosis",
        fix: "Suggested fix:",
        noFix: "No automatic fix available.",
        applyFix: "Apply fix",
        retryHint: "Re-run the original step after applying the fix.",
      },
    },
  },
}

function makePlan(overrides?: Partial<ExecutionPlan>): ExecutionPlan {
  return {
    id: "test-plan",
    intent: "deploy",
    steps: [
      {
        index: 0,
        command: "git checkout main",
        description: "Switch to main",
        status: "pending",
        exitCode: null,
        outputSnippet: null,
        requiresConfirmation: false,
      },
      {
        index: 1,
        command: "npm run build",
        description: "Build project",
        status: "pending",
        exitCode: null,
        outputSnippet: null,
        requiresConfirmation: false,
      },
    ],
    status: "ready",
    createdAt: Date.now(),
    ...overrides,
  }
}

function renderPlanView(
  plan: ExecutionPlan,
  overrides?: {
    generating?: boolean
    executing?: boolean
    advisory?: ErrorAdvisory | null
    advisoryLoading?: boolean
  }
) {
  const props = {
    plan,
    generating: overrides?.generating ?? false,
    executing: overrides?.executing ?? false,
    advisory: overrides?.advisory ?? null,
    advisoryLoading: overrides?.advisoryLoading ?? false,
    onRunAll: jest.fn(),
    onRunNext: jest.fn(),
    onSkip: jest.fn(),
    onEdit: jest.fn(),
    onCancel: jest.fn(),
    onRequestAdvisory: jest.fn(),
    onApplyFix: jest.fn(),
  }
  const utils = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiShellPlanView {...props} />
    </NextIntlClientProvider>
  )
  return { ...utils, props }
}

describe("AiShellPlanView", () => {
  it("renders plan steps", () => {
    renderPlanView(makePlan())
    expect(screen.getByTestId("ai-shell-steps")).toBeInTheDocument()
    expect(screen.getByTestId("ai-shell-step-0")).toBeInTheDocument()
    expect(screen.getByTestId("ai-shell-step-1")).toBeInTheDocument()
  })

  it("shows empty message when no steps", () => {
    renderPlanView(makePlan({ steps: [] }))
    expect(screen.getByText("No steps generated.")).toBeInTheDocument()
  })

  it("shows action buttons when plan is ready", () => {
    renderPlanView(makePlan())
    expect(screen.getByTestId("ai-shell-run-all")).toBeInTheDocument()
    expect(screen.getByTestId("ai-shell-step-by-step")).toBeInTheDocument()
    expect(screen.getByTestId("ai-shell-cancel")).toBeInTheDocument()
  })

  it("shows stop button when executing", () => {
    renderPlanView(makePlan({ status: "executing" as const }), { executing: true })
    expect(screen.getByTestId("ai-shell-stop")).toBeInTheDocument()
  })

  it("hides action buttons when plan is completed", () => {
    renderPlanView(makePlan({ status: "completed" }))
    expect(screen.queryByTestId("ai-shell-actions")).not.toBeInTheDocument()
  })

  it("calls onRunAll when button clicked", () => {
    const { props } = renderPlanView(makePlan())
    fireEvent.click(screen.getByTestId("ai-shell-run-all"))
    expect(props.onRunAll).toHaveBeenCalled()
  })

  it("calls onRunNext when step-by-step clicked", () => {
    const { props } = renderPlanView(makePlan())
    fireEvent.click(screen.getByTestId("ai-shell-step-by-step"))
    expect(props.onRunNext).toHaveBeenCalled()
  })

  it("calls onSkip when skip button clicked", () => {
    const { props } = renderPlanView(makePlan())
    fireEvent.click(screen.getAllByTestId("ai-shell-step-skip")[0])
    expect(props.onSkip).toHaveBeenCalledWith(0)
  })

  it("enters edit mode and commits on Enter", () => {
    const { props } = renderPlanView(makePlan())
    // Click edit on first step
    fireEvent.click(screen.getAllByTestId("ai-shell-step-edit")[0])
    const input = screen.getByTestId("ai-shell-step-edit-input")
    expect(input).toBeInTheDocument()

    fireEvent.change(input, { target: { value: "git checkout develop" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(props.onEdit).toHaveBeenCalledWith(0, "git checkout develop")
  })

  it("shows advisory when present", () => {
    const advisory: ErrorAdvisory = {
      stepIndex: 0,
      diagnosis: "Module not found",
      suggestedFix: "npm install",
      retryAfterFix: true,
    }
    renderPlanView(makePlan(), { advisory })
    expect(screen.getByTestId("ai-shell-advisory")).toBeInTheDocument()
    expect(screen.getByText("Module not found")).toBeInTheDocument()
    expect(screen.getByTestId("ai-shell-apply-fix")).toBeInTheDocument()
  })

  it("calls onApplyFix when fix button clicked", () => {
    const advisory: ErrorAdvisory = {
      stepIndex: 0,
      diagnosis: "Test",
      suggestedFix: "npm install",
      retryAfterFix: true,
    }
    const { props } = renderPlanView(makePlan(), { advisory })
    fireEvent.click(screen.getByTestId("ai-shell-apply-fix"))
    expect(props.onApplyFix).toHaveBeenCalled()
  })

  it("shows failed step output snippet", () => {
    const plan = makePlan({
      steps: [
        {
          index: 0,
          command: "npm build",
          description: "Build",
          status: "failed",
          exitCode: 1,
          outputSnippet: "Error: cannot find module",
          requiresConfirmation: false,
        },
      ],
    })
    renderPlanView(plan)
    expect(screen.getByText("Error: cannot find module")).toBeInTheDocument()
  })
})
