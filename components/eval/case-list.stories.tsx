import type { Meta, StoryObj } from "@storybook/nextjs"

import { CaseList } from "./case-list"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeCases } from "@/lib/storybook/fixtures/eval"

// Browse + CRUD the cases in a dataset (`useEvalCases` live query). Empty DB →
// the empty state; seeded cases render the list with capability/source/split
// badges and edit/delete affordances.
const meta = {
  title: "Eval/CaseList",
  component: CaseList,
  parameters: { layout: "padded" },
  args: { datasetId: "ds-1" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CaseList>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.evalCases.bulkPut(makeCases(6))
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
