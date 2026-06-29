import type { Meta, StoryObj } from "@storybook/nextjs"

import { RecentRunsFeed } from "./recent-runs-feed"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeWorkflow, makeRun } from "@/lib/storybook/fixtures/mobile-workflow"

// Newest-first feed of recent workflow runs, joined to their workflow names.
// Reads `workflowRuns` + `workflows` live from Dexie. Empty DB → the "no runs"
// placeholder.
const meta = {
  title: "Mobile/Workflow/RecentRunsFeed",
  component: RecentRunsFeed,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] py-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RecentRunsFeed>

export default meta
type Story = StoryObj<typeof meta>

export const WithRuns: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      const a = makeWorkflow({ id: "wf-a", name: "Inbox triage" })
      const b = makeWorkflow({ id: "wf-b", name: "Release notes" })
      await db.workflows.bulkPut([a, b])
      await db.workflowRuns.bulkPut([
        makeRun({ workflowId: a.id, status: "succeeded" }),
        makeRun({ workflowId: b.id, status: "failed" }),
        makeRun({ workflowId: a.id, status: "running" }),
      ])
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
