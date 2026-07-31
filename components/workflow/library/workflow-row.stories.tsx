import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowRow } from "./workflow-row"
import type { WorkflowRow as WorkflowRowData } from "@/types/workflow/visual"

const createdAt = 1_700_000_000_000

const workflow: WorkflowRowData = {
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
      type: "action.character.send",
      typeVersion: 1,
      position: { x: 200, y: 0 },
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
  title: "Workflow/WorkflowRow",
  component: WorkflowRow,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="w-[640px]">{Story()}</div>],
  args: { workflow },
} satisfies Meta<typeof WorkflowRow>

export default meta
type Story = StoryObj<typeof meta>

// Compact list row — the counterpart of WorkflowCard.
export const Default: Story = {}

// With run count and a recent-run status pill.
export const WithRunHistory: Story = {
  args: { runCount: 18, lastStatus: "running" },
}
