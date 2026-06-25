import type { Meta, StoryObj } from "@storybook/nextjs"

import { RunStepDetail } from "./run-step-detail"
import type { VisualWorkflow, WorkflowRunEventRow } from "@/types/workflow/visual"

const startedAt = 1_700_000_000_000

const workflow: VisualWorkflow = {
  id: "wf_demo",
  schemaVersion: 2,
  name: "Summarize inbound message",
  createdAt: startedAt - 86_400_000,
  updatedAt: startedAt,
  nodes: [
    {
      id: "n_start",
      type: "trigger.manual",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "Manual trigger", params: {} },
    },
    {
      id: "n_ai",
      type: "action.agent.turn",
      typeVersion: 1,
      position: { x: 240, y: 0 },
      data: { label: "Summarize", params: {} },
    },
  ],
  edges: [{ id: "e1", source: "n_start", target: "n_ai" }],
  settings: {
    errorPolicy: "stop",
    timeoutMs: 60_000,
    concurrency: 1,
    retryDefaults: { attempts: 2, backoff: "exponential", baseMs: 500 },
  },
}

const events: WorkflowRunEventRow[] = [
  {
    id: "ev4",
    runId: "run_1",
    ts: startedAt + 200,
    type: "step_started",
    stepId: "n_ai",
    payload: { params: { prompt: "Summarize the thread" } },
  },
  {
    id: "ev5",
    runId: "run_1",
    ts: startedAt + 250,
    type: "step_retrying",
    stepId: "n_ai",
    payload: { attempt: 1, maxAttempts: 2, delayMs: 300, error: "rate limited" },
  },
  {
    id: "ev6",
    runId: "run_1",
    ts: startedAt + 1_800,
    type: "step_usage",
    stepId: "n_ai",
    payload: {
      inputTokens: 1_200,
      outputTokens: 350,
      totalTokens: 1_550,
      costUsd: 0.012,
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
    },
  },
  {
    id: "ev7",
    runId: "run_1",
    ts: startedAt + 4_200,
    type: "step_completed",
    stepId: "n_ai",
    payload: { output: { text: "Here is the summary." } },
  },
]

const failedEvents: WorkflowRunEventRow[] = [
  {
    id: "evf1",
    runId: "run_2",
    ts: startedAt + 200,
    type: "step_started",
    stepId: "n_ai",
    payload: { params: { prompt: "Summarize the thread" } },
  },
  {
    id: "evf2",
    runId: "run_2",
    ts: startedAt + 900,
    type: "run_log",
    stepId: "n_ai",
    level: "error",
    payload: { message: "Provider call failed", data: { code: 500 } },
  },
  {
    id: "evf3",
    runId: "run_2",
    ts: startedAt + 1_000,
    type: "step_failed",
    stepId: "n_ai",
    payload: {
      message: "Provider 500",
      retryable: false,
      stack: "Error: Provider 500\n  at exec (runtime.ts:42)",
    },
  },
]

const meta = {
  title: "Workflow/RunStepDetail",
  component: RunStepDetail,
  parameters: { layout: "padded" },
  args: { workflow, events, stepId: "n_ai" },
} satisfies Meta<typeof RunStepDetail>

export default meta
type Story = StoryObj<typeof meta>

// A completed AI step — params, output, token usage, and attempt count.
export const Completed: Story = {}

// A failed step — error pane (message + stack) and an error log row.
export const Failed: Story = {
  args: { events: failedEvents, stepId: "n_ai" },
}

// Nothing selected — the "pick a step" prompt.
export const NoSelection: Story = {
  args: { stepId: null },
}
