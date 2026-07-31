import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalOverviewTab } from "./overview-tab"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeGoal, makeGoalEventLog } from "@/lib/storybook/fixtures/goal"

const goal = makeGoal()

// Status badges, twin progress bars, and the latest judge reason — the reason
// is read live from `chatGoalEvents`, so the populated story seeds that log.
const meta = {
  title: "Goal/OverviewTab",
  component: GoalOverviewTab,
  args: { goal },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoalOverviewTab>

export default meta
type Story = StoryObj<typeof meta>

// Empty DB → no judge reason line.
export const NoEvents: Story = {}

export const WithJudgeReason: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.chatGoalEvents.bulkAdd(makeGoalEventLog(goal.id))
    })
  },
}

export const Completed: Story = {
  args: { goal: makeGoal({ status: "completed", endedAt: goal.updatedAt }) },
}
