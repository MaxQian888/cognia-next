import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowDetail } from "./workflow-detail"

// `WorkflowDetail` loads a `workflowTriggers` row (and its parent workflow) from
// Dexie by `workflowTriggerId`, exposing the cron/webhook config, a deep link
// into the workflow editor, and recent fires. With no seeded trigger the live
// query resolves to `undefined`, so the panel renders its "trigger not found"
// fallback.
const meta = {
  title: "Scheduler/Details/WorkflowDetail",
  component: WorkflowDetail,
  parameters: { layout: "fullscreen" },
  args: {
    onSelectRun: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl border rounded-md bg-card">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowDetail>

export default meta
type Story = StoryObj<typeof meta>

// Trigger id with no backing row → "not found" fallback.
export const NotFound: Story = {
  args: {
    workflowTriggerId: "workflow-trigger-missing",
  },
}
