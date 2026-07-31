import type { Meta, StoryObj } from "@storybook/nextjs"

import { RunList } from "./run-list"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeRun } from "@/lib/storybook/fixtures/mobile-workflow"

// `RunList` live-queries `workflowRuns` for one workflow via the
// `[workflowId+startedAt]` index. Seed a spread of statuses/triggers into the
// (empty) Storybook IndexedDB so the stat band, filters, and table all populate.
const WORKFLOW_ID = "wf_runs_demo"

const meta = {
  title: "Workflow/Runs/RunList",
  component: RunList,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="mx-auto w-full max-w-4xl p-6">{Story()}</div>],
  args: { workflowId: WORKFLOW_ID },
} satisfies Meta<typeof RunList>

export default meta
type Story = StoryObj<typeof meta>

// A mixed run history: successes, a failure, a cancelled run, and one running.
export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.workflowRuns.bulkPut([
        makeRun({ workflowId: WORKFLOW_ID, status: "succeeded", triggerKind: "trigger.manual" }),
        makeRun({ workflowId: WORKFLOW_ID, status: "succeeded", triggerKind: "trigger.cron" }),
        makeRun({ workflowId: WORKFLOW_ID, status: "failed", triggerKind: "trigger.cron" }),
        makeRun({ workflowId: WORKFLOW_ID, status: "cancelled", triggerKind: "trigger.manual" }),
        makeRun({ workflowId: WORKFLOW_ID, status: "running", triggerKind: "trigger.manual" }),
      ])
    })
  },
}

// No runs yet — the empty state.
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
