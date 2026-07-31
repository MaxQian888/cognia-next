import type { Meta, StoryObj } from "@storybook/nextjs"

import { PinnedSection } from "./pinned-section"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeWorkflow, makeRun } from "@/lib/storybook/fixtures/mobile-workflow"

// 2-column grid of pinned workflows, each with a trigger button + an optional
// "active" badge driven live by the `workflowRuns` Dexie table. Returns null
// when none of `workflows` are in `pinnedIds`.
const wfA = makeWorkflow({ id: "wf-a", name: "Inbox triage" })
const wfB = makeWorkflow({ id: "wf-b", name: "Daily standup digest" })
const wfC = makeWorkflow({ id: "wf-c", name: "Release notes" })

const meta = {
  title: "Mobile/Workflow/PinnedSection",
  component: PinnedSection,
  parameters: { layout: "fullscreen" },
  args: { workflows: [wfA, wfB, wfC], pinnedIds: [wfA.id, wfB.id] },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] py-4">
        <Story />
      </div>
    ),
  ],
  beforeEach: async () => {
    await seedDb(async () => {})
  },
} satisfies Meta<typeof PinnedSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// One pinned workflow has a run in the `running` state → "active" badge.
export const WithActiveRun: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.workflowRuns.bulkPut([makeRun({ workflowId: wfA.id, status: "running" })])
    })
  },
}
