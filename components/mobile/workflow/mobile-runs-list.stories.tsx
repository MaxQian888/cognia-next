import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileRunsList } from "./mobile-runs-list"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeRun } from "@/lib/storybook/fixtures/mobile-workflow"

// Single-workflow run history inside the mobile sub-page shell: status filter
// chips + the vertical run list + a clear-history action. Reads `workflowRuns`
// live from Dexie and filters to `workflowId` in JS.
const WORKFLOW_ID = "wf-runs-demo"

const meta = {
  title: "Mobile/Workflow/MobileRunsList",
  component: MobileRunsList,
  parameters: { layout: "fullscreen" },
  args: { workflowId: WORKFLOW_ID },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileRunsList>

export default meta
type Story = StoryObj<typeof meta>

export const WithRuns: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.workflowRuns.bulkPut([
        makeRun({ workflowId: WORKFLOW_ID, status: "succeeded" }),
        makeRun({ workflowId: WORKFLOW_ID, status: "failed", error: { message: "HTTP 500 from webhook" } }),
        makeRun({ workflowId: WORKFLOW_ID, status: "running", completedAt: undefined }),
        makeRun({ workflowId: WORKFLOW_ID, status: "cancelled" }),
      ])
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
