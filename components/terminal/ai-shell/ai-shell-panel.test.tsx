/**
 * @jest-environment jsdom
 */

/**
 * Tests for the AI Shell panel component.
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { AiShellPanel } from "./ai-shell-panel"
import type { UseAiShellState, UseAiShellActions } from "@/hooks/terminal/use-ai-shell"
import type { ExecutionPlan } from "@/lib/terminal/ai-shell"

// Mock MotionPopover to render children directly when open
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  MotionPopover: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="motion-popover">{children}</div> : null,
}))

const messages = {
  terminal: {
    aiShell: {
      title: "AI Shell",
      toggle: "Toggle AI Shell",
      inputPlaceholder: "Describe what you want to do…",
      send: "Send",
      context: { branch: "Branch", cwd: "CWD", shell: "Shell" },
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
      error: {
        noModel: "No model configured.",
        piiBlocked: "Context contains secrets.",
        generating: "Error generating plan.",
        advisory: "Diagnosis",
      },
      advisory: {
        title: "Error Diagnosis",
        fix: "Suggested fix:",
        noFix: "No automatic fix available.",
        applyFix: "Apply fix",
        retryHint: "Re-run the original step after applying the fix.",
      },
      history: {
        title: "AI Shell history",
        clear: "Clear history",
        empty: "No messages yet.",
      },
    },
  },
}

function makeState(overrides?: Partial<UseAiShellState>): UseAiShellState {
  return {
    open: true,
    messages: [],
    plan: null,
    generating: false,
    executing: false,
    advisory: null,
    advisoryLoading: false,
    ...overrides,
  }
}

function makeActions(): UseAiShellActions {
  return {
    toggle: jest.fn(),
    openPanel: jest.fn(),
    closePanel: jest.fn(),
    submit: jest.fn().mockResolvedValue(undefined),
    runAll: jest.fn().mockResolvedValue(undefined),
    runNextStep: jest.fn().mockResolvedValue(undefined),
    skipStep: jest.fn(),
    editStep: jest.fn(),
    cancel: jest.fn(),
    requestAdvisory: jest.fn().mockResolvedValue(undefined),
    applyFix: jest.fn().mockResolvedValue(undefined),
    clearHistory: jest.fn(),
  }
}

function renderPanel(state: UseAiShellState, actions: UseAiShellActions) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiShellPanel state={state} actions={actions} />
    </NextIntlClientProvider>
  )
}

describe("AiShellPanel", () => {
  it("renders nothing when closed", () => {
    const { container } = renderPanel(makeState({ open: false }), makeActions())
    expect(container.innerHTML).toBe("")
  })

  it("renders the panel when open", () => {
    renderPanel(makeState(), makeActions())
    expect(screen.getByTestId("ai-shell-panel")).toBeInTheDocument()
  })

  it("shows empty state when no messages", () => {
    renderPanel(makeState(), makeActions())
    expect(screen.getByTestId("ai-shell-empty")).toBeInTheDocument()
  })

  it("renders messages", () => {
    const state = makeState({
      messages: [
        { id: "1", role: "user", content: "Deploy to staging", timestamp: 1000 },
        { id: "2", role: "assistant", content: "Plan generated.", timestamp: 2000 },
      ],
    })
    renderPanel(state, makeActions())

    expect(screen.getByTestId("ai-shell-messages")).toBeInTheDocument()
    expect(screen.getByTestId("ai-shell-msg-user")).toHaveTextContent("Deploy to staging")
    expect(screen.getByTestId("ai-shell-msg-assistant")).toHaveTextContent("Plan generated.")
  })

  it("disables input when generating", () => {
    renderPanel(makeState({ generating: true }), makeActions())
    expect(screen.getByTestId("ai-shell-input")).toBeDisabled()
  })

  it("disables input when executing", () => {
    renderPanel(makeState({ executing: true }), makeActions())
    expect(screen.getByTestId("ai-shell-input")).toBeDisabled()
  })

  it("calls closePanel when X button clicked", () => {
    const actions = makeActions()
    renderPanel(makeState(), actions)
    fireEvent.click(screen.getByTestId("ai-shell-close"))
    expect(actions.closePanel).toHaveBeenCalled()
  })

  it("calls clearHistory when trash button clicked", () => {
    const actions = makeActions()
    renderPanel(makeState(), actions)
    fireEvent.click(screen.getByTestId("ai-shell-clear"))
    expect(actions.clearHistory).toHaveBeenCalled()
  })

  it("submits on Enter key in input", () => {
    const actions = makeActions()
    renderPanel(makeState(), actions)

    const input = screen.getByTestId("ai-shell-input")
    fireEvent.change(input, { target: { value: "deploy" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(actions.submit).toHaveBeenCalledWith("deploy")
  })

  it("does not submit on Shift+Enter", () => {
    const actions = makeActions()
    renderPanel(makeState(), actions)

    const input = screen.getByTestId("ai-shell-input")
    fireEvent.change(input, { target: { value: "deploy" } })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })

    expect(actions.submit).not.toHaveBeenCalled()
  })

  it("renders plan when present", () => {
    const plan: ExecutionPlan = {
      id: "p1",
      intent: "deploy",
      steps: [
        {
          index: 0,
          command: "git checkout main",
          description: "Switch branch",
          status: "pending",
          exitCode: null,
          outputSnippet: null,
          requiresConfirmation: false,
        },
      ],
      status: "ready",
      createdAt: Date.now(),
    }
    renderPanel(makeState({ plan }), makeActions())
    expect(screen.getByTestId("ai-shell-plan")).toBeInTheDocument()
    expect(screen.getByTestId("ai-shell-step-0")).toBeInTheDocument()
  })
})
