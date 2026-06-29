import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinJobsTab } from "./twin-jobs-tab"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeTwinJob, makeTwinSource } from "@/lib/storybook/fixtures/twin"

// Dexie-backed: `useLiveQuery(listTwinJobsByTwin)` reads the `twinJobs` table
// (plus a pending-sources count). Default renders the empty state.
const TWIN_ID = "twin-1"

const meta = {
  title: "Twin/Tabs/JobsTab",
  component: TwinJobsTab,
  parameters: { layout: "fullscreen" },
  args: { twinId: TWIN_ID },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinJobsTab>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

export const WithJobs: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.twinSources.bulkPut([makeTwinSource({ twinId: TWIN_ID, status: "pending" })])
      await db.twinJobs.bulkPut([
        makeTwinJob({
          twinId: TWIN_ID,
          kind: "ingest",
          status: "running",
          phase: "embedding",
          progress: 60,
        }),
        makeTwinJob({ twinId: TWIN_ID, kind: "distill", status: "completed", progress: 100 }),
        makeTwinJob({
          twinId: TWIN_ID,
          kind: "ingest",
          status: "failed",
          progress: 30,
          errorMessage: "Embedding provider rate-limited.",
        }),
      ])
    })
  },
}
