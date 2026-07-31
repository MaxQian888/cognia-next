import type { Meta, StoryObj } from "@storybook/nextjs"

import { RunsComparePanel } from "./runs-compare-panel"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeRuns } from "@/lib/storybook/fixtures/eval"

// Runs & Compare pane (`useRecentRuns` → RunComparisonView). Seeded runs drive
// the comparison selector; empty DB shows the "no runs" state.
const meta = {
  title: "Eval/RunsComparePanel",
  component: RunsComparePanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RunsComparePanel>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.evalRuns.bulkPut(makeRuns())
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
