import type { Meta, StoryObj } from "@storybook/nextjs"

import { EvalDashboard } from "./eval-dashboard"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeDataset, makeCases } from "@/lib/storybook/fixtures/eval"

// Datasets master-detail pane (`useEvalDatasets` + settings store). Seeded
// datasets render the list with an inline DatasetDetail for the first row;
// empty DB shows the empty list + "select a dataset" hint.
const meta = {
  title: "Eval/EvalDashboard",
  component: EvalDashboard,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[680px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EvalDashboard>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.evalDatasets.bulkPut([
        makeDataset({ id: "ds-1", name: "Tool-use regression suite" }),
        makeDataset({
          id: "ds-2",
          name: "RAG faithfulness",
          capability: "rag.retrieval",
          version: 2,
        }),
      ])
      await db.evalCases.bulkPut(makeCases(5))
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
