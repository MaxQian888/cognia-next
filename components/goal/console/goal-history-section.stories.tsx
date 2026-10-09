import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ALL_GOAL_STATUSES, GoalHistorySection } from "./goal-history-section"
import { makeGoalSet } from "@/lib/storybook/fixtures/goal"
import { seedDb } from "@/lib/storybook/seed-db"

// History section of the Goals console: every goal of the workspace, newest
// first, with search, a status filter (owned by the console), sort + direction,
// a status chip per row, the goal's conversation link and a ⋯ menu. Reads
// Dexie live, so each story seeds its own rows.
const meta = {
  title: "Goal/Console/GoalHistorySection",
  component: GoalHistorySection,
  args: {
    selectedGoalId: null,
    onSelect: fn(),
    onDeleted: fn(),
    statusFilter: ALL_GOAL_STATUSES,
    onStatusFilterChange: fn(),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoalHistorySection>

export default meta
type Story = StoryObj<typeof meta>

/** A spread of goals across statuses. */
export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.chatGoals.bulkAdd(makeGoalSet())
    })
  },
}

/** The row the inspector is showing is highlighted. */
export const WithSelection: Story = {
  args: { selectedGoalId: "goal_4" },
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.chatGoals.bulkAdd(makeGoalSet())
    })
  },
}

/** Filtered to completed goals, as the lifetime strip's Completed cell opens it. */
export const FilteredToCompleted: Story = {
  args: { statusFilter: "completed" },
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.chatGoals.bulkAdd(makeGoalSet())
    })
  },
}

/** No goals yet: the empty state with its own New goal trigger. */
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(() => {})
  },
}
