import type { Meta, StoryObj } from "@storybook/nextjs"

import { EvalWorkspace } from "./eval-workspace"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeDataset } from "@/lib/storybook/fixtures/eval"

// Eval workspace shell — segmented switch across Datasets / Compare / Annotate
// / Calibrate. Default lands on the datasets pane (EvalDashboard).
const meta = {
  title: "Eval/EvalWorkspace",
  component: EvalWorkspace,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[720px] w-full">
        <Story />
      </div>
    ),
  ],
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.evalDatasets.bulkPut([makeDataset()])
    })
  },
} satisfies Meta<typeof EvalWorkspace>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
