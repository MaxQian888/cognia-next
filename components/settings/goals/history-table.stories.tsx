import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalsHistoryTable } from "./history-table"
import { seedDb } from "@/lib/storybook/seed-db"

// `GoalsHistoryTable` is a Dexie-backed, newest-first list of every goal with a
// search box, status filter, sortable columns, row-click detail sheet, and a
// per-row delete confirm. On an empty database it shows the "no goals yet"
// empty state.
const meta = {
  title: "Settings/Goals/GoalsHistoryTable",
  component: GoalsHistoryTable,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await seedDb(() => {})
  },
  decorators: [
    (Story) => (
      <div className="max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoalsHistoryTable>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
