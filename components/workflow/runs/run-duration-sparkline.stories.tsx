import type { Meta, StoryObj } from "@storybook/nextjs"

import { RunDurationSparkline } from "./run-duration-sparkline"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeRun } from "@/lib/storybook/fixtures/mobile-workflow"

// Tiny recharts sparkline of the duration trend across a workflow's most recent
// runs. Hidden when fewer than 2 completed runs exist, so the default seeds a
// handful with varied durations.
const WORKFLOW_ID = "wf_spark_demo"

const meta = {
  title: "Workflow/Runs/RunDurationSparkline",
  component: RunDurationSparkline,
  parameters: { layout: "centered" },
  args: { workflowId: WORKFLOW_ID },
} satisfies Meta<typeof RunDurationSparkline>

export default meta
type Story = StoryObj<typeof meta>

// Six completed runs with a creeping-upward duration trend.
export const Trend: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      const base = 1_700_000_000_000
      const durations = [1200, 1500, 1400, 2100, 2600, 3300]
      await db.workflowRuns.bulkPut(
        durations.map((d, i) =>
          makeRun({
            workflowId: WORKFLOW_ID,
            status: "succeeded",
            startedAt: base + i * 3_600_000,
            completedAt: base + i * 3_600_000 + d,
          })
        )
      )
    })
  },
}
