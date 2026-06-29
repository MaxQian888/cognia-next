import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalConsole } from "./goal-console"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeGoalSet } from "@/lib/storybook/fixtures/goal"

// The full "Mission Control" dashboard: a live StatCard row, the open-goals
// section, and the History / Analytics / Templates / Defaults / Tracker tabs.
// It reads all goals from Dexie via `listAllGoals`, so the populated story
// seeds a spread across statuses.
const meta = {
  title: "Goal/GoalConsole",
  component: GoalConsole,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[720px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoalConsole>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.chatGoals.bulkAdd(makeGoalSet())
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
