import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowCard } from "./workflow-card"
import type { WorkflowRow } from "@/types/workflow/visual"

const createdAt = 1_700_000_000_000

const workflow: WorkflowRow = {
  id: "wf_sample",
  schemaVersion: 2,
  name: "Daily standup summary",
  description: "Collects overnight updates and posts a digest every morning.",
  tags: ["daily", "ai"],
  createdAt,
  updatedAt: createdAt + 86_400_000,
  nodes: [
    {
      id: "n1",
      type: "trigger.manual",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "Trigger", params: {} },
    },
    {
      id: "n2",
      type: "action.agent.turn",
      typeVersion: 1,
      position: { x: 200, y: 0 },
      data: { label: "Summarize", params: {} },
    },
    {
      id: "n3",
      type: "action.character.send",
      typeVersion: 1,
      position: { x: 400, y: 0 },
      data: { label: "Send", params: {} },
    },
  ],
  edges: [],
  settings: {
    errorPolicy: "stop",
    timeoutMs: 60_000,
    concurrency: 1,
    retryDefaults: { attempts: 2, backoff: "exponential", baseMs: 500 },
  },
}

const meta = {
  title: "Workflow/WorkflowCard",
  component: WorkflowCard,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="w-[340px]">{Story()}</div>],
  args: { workflow },
} satisfies Meta<typeof WorkflowCard>

export default meta
type Story = StoryObj<typeof meta>

// Description, node/trigger/action badges, and tags.
export const Default: Story = {}

// With a run-history badge and a "last run" status pill.
export const WithRunHistory: Story = {
  args: { runCount: 42, lastStatus: "succeeded" },
}

// Most recent run failed.
export const LastRunFailed: Story = {
  args: { runCount: 7, lastStatus: "failed" },
}

// A built-in template workflow with no description.
export const BuiltinTemplate: Story = {
  args: {
    workflow: {
      ...workflow,
      id: "wf_builtin",
      name: "Triage new issues",
      description: undefined,
      tags: [],
      isBuiltIn: true,
      isTemplate: true,
    },
  },
}
