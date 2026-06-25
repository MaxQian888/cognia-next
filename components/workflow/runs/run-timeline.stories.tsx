import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { RunTimeline } from "./run-timeline"
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
    {
      id: "n_send",
      type: "action.character.send",
      typeVersion: 1,
      position: { x: 480, y: 0 },
      data: { label: "Reply", params: {} },
    },
  ],
  edges: [
    { id: "e1", source: "n_start", target: "n_ai" },
    { id: "e2", source: "n_ai", target: "n_send" },
  ],
  settings: {
    errorPolicy: "stop",
    timeoutMs: 60_000,
    concurrency: 1,
    retryDefaults: { attempts: 2, backoff: "exponential", baseMs: 500 },
  },
}

const events: WorkflowRunEventRow[] = [
  {
    id: "ev2",
    runId: "run_1",
    ts: startedAt,
    type: "step_started",
    stepId: "n_start",
    payload: { params: {} },
  },
  {
    id: "ev3",
    runId: "run_1",
    ts: startedAt + 120,
    type: "step_completed",
    stepId: "n_start",
    payload: { output: { ok: true } },
  },
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
    id: "ev7",
    runId: "run_1",
    ts: startedAt + 4_200,
    type: "step_completed",
    stepId: "n_ai",
    payload: { output: { text: "Here is the summary." } },
  },
  {
    id: "ev8",
    runId: "run_1",
    ts: startedAt + 4_300,
    type: "step_started",
    stepId: "n_send",
    payload: { params: { text: "Here is the summary." } },
  },
  {
    id: "ev9",
    runId: "run_1",
    ts: startedAt + 4_600,
    type: "step_completed",
    stepId: "n_send",
    payload: { output: { delivered: true } },
  },
]

const meta = {
  title: "Workflow/RunTimeline",
  component: RunTimeline,
  parameters: { layout: "padded" },
  args: {
    workflow,
    events,
    startedAt,
    completedAt: startedAt + 4_600,
    selectedStepId: "n_ai",
    onSelectStep: fn(),
  },
} satisfies Meta<typeof RunTimeline>

export default meta
type Story = StoryObj<typeof meta>

// Finished run — Gantt rows with the AI step selected and a "retried" marker.
export const Completed: Story = {}

// Still running — the final step span stays open (no completedAt).
export const Running: Story = {
  args: { completedAt: undefined, events: events.slice(0, 4) },
}

// No events yet — the "waiting" placeholder.
export const Waiting: Story = {
  args: { events: [], completedAt: undefined, selectedStepId: null },
}
