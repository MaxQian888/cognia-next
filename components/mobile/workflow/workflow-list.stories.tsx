import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowList } from "./workflow-list"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { useSettingsStore } from "@/stores/settings"
import { makeWorkflow, makeRun } from "@/lib/storybook/fixtures/mobile-workflow"

// The full mobile workflow library: toolbar → pinned grid → workflow rows →
// recent-runs feed. Reads the `useWorkflowLibraryStore` slice (query / sort /
// filters / folder) + `useSettingsStore` (pins / density) and a fan-out of
// Dexie live queries (folders, workflows-in-folder, run counts, active runs).
const meta = {
  title: "Mobile/Workflow/WorkflowList",
  component: WorkflowList,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowList>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: async () => {
    const a = makeWorkflow({ id: "wf-a", name: "Inbox triage" })
    const b = makeWorkflow({ id: "wf-b", name: "Daily standup digest" })
    const c = makeWorkflow({ id: "wf-c", name: "Release notes" })
    await seedDb(async (db) => {
      await db.workflows.bulkPut([a, b, c])
      await db.workflowRuns.bulkPut([
        makeRun({ workflowId: a.id, status: "running" }),
        makeRun({ workflowId: b.id, status: "succeeded" }),
      ])
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
