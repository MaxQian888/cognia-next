import type { Meta, StoryObj } from "@storybook/nextjs"

import { DatasetDetail } from "./dataset-detail"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeDataset, makeCases } from "@/lib/storybook/fixtures/eval"

// Dataset detail pane: header (name/version/capability/gate) + actions +
// Cases | Runs | Versions segments. The Cases segment reads Dexie via
// `useEvalCases`, so cases are seeded for a populated body.
const meta = {
  title: "Eval/DatasetDetail",
  component: DatasetDetail,
  parameters: { layout: "fullscreen" },
  args: { dataset: makeDataset(), appSettings: null },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full p-3">
        <Story />
      </div>
    ),
  ],
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.evalCases.bulkPut(makeCases(6))
    })
  },
} satisfies Meta<typeof DatasetDetail>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithGate: Story = {
  args: {
    dataset: makeDataset({ gate: { minPassAt1: 0.9, maxTotalCostUsd: 1.5 } }),
  },
}
