/**
 * @jest-environment jsdom
 *
 * Coverage for the step inspector's streaming + usage additions (workflow ×
 * LLM deep integration). The pre-existing sections (params/output/logs) get
 * baseline assertions so regressions there surface too.
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import type { VisualWorkflow, WorkflowRunEventRow } from "@/types/workflow/visual"
import { RunStepDetail } from "./run-step-detail"

const workflow: VisualWorkflow = {
  id: "wf1",
  schemaVersion: 1,
  name: "t",
  createdAt: 0,
  updatedAt: 0,
  nodes: [
    {
      id: "n1",
      type: "ai.prompt",
      typeVersion: 2,
      position: { x: 0, y: 0 },
      data: { label: "Ask", params: { userPrompt: "hi" } },
    },
  ],
  edges: [],
  settings: {
    errorPolicy: "stop",
    timeoutMs: 60_000,
    concurrency: 1,
    retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
  },
}

function ev(partial: Partial<WorkflowRunEventRow> & Pick<WorkflowRunEventRow, "ts" | "type">) {
  return {
    id: `evt_${partial.ts}_${partial.type}`,
    runId: "r1",
    stepId: "n1",
    ...partial,
  } as WorkflowRunEventRow
}

function wrap(events: WorkflowRunEventRow[], stepId: string | null = "n1") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RunStepDetail workflow={workflow} events={events} stepId={stepId} />
    </NextIntlClientProvider>
  )
}

describe("RunStepDetail", () => {
  it("prompts for a selection when no step is chosen", () => {
    wrap([], null)
    expect(screen.getByText("Select a step in the timeline to inspect.")).toBeInTheDocument()
  })

  it("sizes the summary stats against its own pane, not the window", () => {
    // The detail renders both full-width on the runs page and inside the
    // editor's Context Workbench panel, which drags to 240px. A viewport
    // `sm:` breakpoint split the stats into two columns inside that panel on
    // any wide desktop.
    const { container } = wrap([
      ev({ ts: 1, type: "step_started" }),
      ev({ ts: 2, type: "step_completed", payload: { output: {} } }),
    ])
    const root = container.querySelector(".space-y-5") as HTMLElement
    expect(root.className).toContain("@container/run-step")
    const stats = container.querySelector(".grid.grid-cols-1") as HTMLElement
    expect(stats.className).toContain("@xs/run-step:grid-cols-2")
    expect(stats.className).not.toContain("sm:grid-cols-2")
  })

  it("shows the live streaming section while the step is running", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: { userPrompt: "hi" } } }),
      ev({ ts: 12, type: "step_stream", payload: { delta: "partial answer", seq: 0 } }),
    ])
    const block = screen.getByTestId("step-streaming-output")
    expect(block.textContent).toContain("partial answer")
    expect(screen.getByText("Live output")).toBeInTheDocument()
  })

  it("hides the streaming section and shows output once completed", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: {} } }),
      ev({ ts: 12, type: "step_stream", payload: { delta: "x", seq: 0 } }),
      ev({ ts: 20, type: "step_completed", payload: { output: { completion: "full text" } } }),
    ])
    expect(screen.queryByTestId("step-streaming-output")).toBeNull()
    expect(screen.getByText(/full text/)).toBeInTheDocument()
  })

  it("renders token / cost / served-by stats from the step_usage event", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: {} } }),
      ev({
        ts: 15,
        type: "step_usage",
        payload: {
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          costUsd: 0.0042,
          providerId: "openai",
          modelId: "gpt-x",
        },
      }),
      ev({ ts: 20, type: "step_completed", payload: { output: { completion: "done" } } }),
    ])
    expect(screen.getByText("Tokens (in / out)")).toBeInTheDocument()
    expect(screen.getByText("1.5k (1.2k / 300)")).toBeInTheDocument()
    expect(screen.getByText("$0.0042 est.")).toBeInTheDocument()
    expect(screen.getByText("openai · gpt-x")).toBeInTheDocument()
  })

  it("renders a dash for usage without pricing", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: {} } }),
      ev({
        ts: 15,
        type: "step_usage",
        payload: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
      ev({ ts: 20, type: "step_completed", payload: { output: {} } }),
    ])
    expect(screen.getByText("Cost")).toBeInTheDocument()
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("lists retry attempts from step_retrying events", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: {} } }),
      ev({
        ts: 12,
        type: "step_retrying",
        payload: { attempt: 1, maxAttempts: 3, delayMs: 500, error: "rate limited" },
      }),
      ev({ ts: 20, type: "step_started", payload: { params: {} } }),
      ev({ ts: 30, type: "step_completed", payload: { output: {} } }),
    ])
    const attempts = screen.getByTestId("step-attempts")
    expect(attempts.textContent).toContain("#1/3")
    expect(attempts.textContent).toContain("rate limited")
  })

  it("shows error details for a failed step", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: {} } }),
      ev({ ts: 12, type: "step_failed", payload: { message: "boom", retryable: false } }),
    ])
    expect(screen.getByText("boom")).toBeInTheDocument()
    expect(
      screen.getByText("This error is marked non-retryable; retries were skipped.")
    ).toBeInTheDocument()
  })
})
