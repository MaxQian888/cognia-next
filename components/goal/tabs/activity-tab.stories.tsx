import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalActivityTab } from "./activity-tab"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeGoal, makeGoalEventLog } from "@/lib/storybook/fixtures/goal"

const goal = makeGoal()

// Reverse-chrono lifecycle log from `chatGoalEvents`. The populated story seeds
// a realistic event log; the empty story leaves the DB empty.
const meta = {
  title: "Goal/ActivityTab",
  component: GoalActivityTab,
  args: { goal },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoalActivityTab>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.chatGoalEvents.bulkAdd(makeGoalEventLog(goal.id))
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
