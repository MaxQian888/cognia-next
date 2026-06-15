/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type VisualWorkflow,
  type WorkflowRunEventRow,
} from "@/types/workflow/visual"
import { RunStepBreakdown } from "./run-step-breakdown"

const workflow: VisualWorkflow = {
  id: "wf",
  schemaVersion: 2,
  name: "wf",
  createdAt: 0,
  updatedAt: 0,
  nodes: [
    {
      id: "s1",
      type: "trigger.manual" as never,
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "Start", params: {} },
    },
    {
      id: "s2",
      type: "ai.prompt" as never,
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "Ask", params: {} },
    },
  ],
  edges: [],
  settings: DEFAULT_WORKFLOW_SETTINGS,
}

function ev(
  ts: number,
  type: WorkflowRunEventRow["type"],
  stepId: string,
  payload?: unknown
): WorkflowRunEventRow {
  return { id: `${type}-${stepId}-${ts}`, runId: "r", ts, type, stepId, payload }
}

function wrap(events: WorkflowRunEventRow[], completedAt: number | undefined = 700) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RunStepBreakdown
        workflow={workflow}
        events={events}
        startedAt={0}
        completedAt={completedAt}
      />
    </NextIntlClientProvider>
  )
}

describe("RunStepBreakdown", () => {
  const events = [
    ev(0, "step_started", "s1"),
    ev(100, "step_completed", "s1"),
    ev(100, "step_started", "s2"),
    ev(700, "step_completed", "s2"),
    ev(700, "step_usage", "s2", { inputTokens: 10, outputTokens: 5, costUsd: 0.002 }),
  ]

  it("renders one row per step with durations, tokens, and cost", () => {
    wrap(events)
    const s1 = screen.getByTestId("breakdown-row-s1")
    const s2 = screen.getByTestId("breakdown-row-s2")
    expect(within(s1).getByText("Start")).toBeInTheDocument()
    expect(within(s2).getByText("Ask")).toBeInTheDocument()
    // s2 reported usage.
    expect(within(s2).getByText("15")).toBeInTheDocument()
  })

  it("flags the slowest step", () => {
    wrap(events)
    const s2 = screen.getByTestId("breakdown-row-s2")
    expect(within(s2).getByText("Slowest")).toBeInTheDocument()
  })

  it("sorts by duration on toggle", async () => {
    wrap(events)
    await userEvent.setup().click(screen.getByTestId("breakdown-sort-duration"))
    const rows = screen.getAllByTestId(/^breakdown-row-/)
    // Slowest (s2, 600ms) first after sorting.
    expect(rows[0]).toHaveAttribute("data-testid", "breakdown-row-s2")
  })

  it("shows an empty state when no steps ran", () => {
    wrap([], undefined)
    expect(screen.getByText("No steps ran yet.")).toBeInTheDocument()
  })
})
