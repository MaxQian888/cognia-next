import type { Meta, StoryObj } from "@storybook/nextjs"

import { DeadLetterPanel } from "./dead-letter-panel"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeRun } from "@/lib/storybook/fixtures/mobile-workflow"

// Recovery surface for terminally-failed runs. Live-queries `status: "failed"`
// runs that have not been acknowledged (`acknowledgedAt === undefined`) and
// offers replay / resume / dismiss. Renders nothing when the queue is empty, so
// the default seeds a couple of failed runs.
const WORKFLOW_ID = "wf_dlq_demo"

const meta = {
  title: "Workflow/Runs/DeadLetterPanel",
  component: DeadLetterPanel,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto w-full max-w-2xl">{Story()}</div>],
} satisfies Meta<typeof DeadLetterPanel>

export default meta
type Story = StoryObj<typeof meta>

// Two unacknowledged failures scoped to one workflow.
export const WithFailures: Story = {
  args: { workflowId: WORKFLOW_ID },
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.workflowRuns.bulkPut([
        makeRun({
          workflowId: WORKFLOW_ID,
          status: "failed",
          error: { message: "Step timed out after 60s", nodeId: "n_fetch", retryable: true },
        }),
        makeRun({
          workflowId: WORKFLOW_ID,
          status: "failed",
          error: { message: "HTTP 502 from upstream", nodeId: "n_http" },
        }),
      ])
    })
  },
}

// Global view across workflows (no `workflowId` scope).
export const GlobalScope: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.workflowRuns.bulkPut([
        makeRun({ workflowId: "wf_a", status: "failed", error: { message: "boom" } }),
        makeRun({ workflowId: "wf_b", status: "failed", error: { message: "kaboom" } }),
      ])
    })
  },
}
