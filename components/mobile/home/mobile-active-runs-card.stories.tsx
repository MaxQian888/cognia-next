import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileActiveRunsCard } from "./mobile-active-runs-card"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeWorkflow, makeRun } from "@/lib/storybook/fixtures/mobile-workflow"

// Compact "active runs" card on the mobile home. Self-hides when no workflow is
// running, so the meaningful story seeds running `workflowRuns` (+ their parent
// `workflows` for the name). The empty-DB case renders nothing by design.
const meta = {
  title: "Mobile/Home/MobileActiveRunsCard",
  component: MobileActiveRunsCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileActiveRunsCard>

export default meta
type Story = StoryObj<typeof meta>

export const SingleRunning: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      const wf = makeWorkflow({ id: "wf-daily", name: "Daily standup digest" })
      await db.workflows.bulkPut([wf])
      await db.workflowRuns.bulkPut([makeRun({ workflowId: wf.id, status: "running" })])
    })
  },
}

export const MultipleRunning: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      const a = makeWorkflow({ id: "wf-a", name: "Inbox triage" })
      const b = makeWorkflow({ id: "wf-b", name: "Release notes" })
      await db.workflows.bulkPut([a, b])
      await db.workflowRuns.bulkPut([
        makeRun({ workflowId: a.id, status: "running" }),
        makeRun({ workflowId: b.id, status: "running" }),
      ])
    })
  },
}
