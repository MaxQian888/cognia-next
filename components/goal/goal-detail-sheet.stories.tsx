import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { GoalDetailSheet } from "./goal-detail-sheet"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeGoal, makeGoalEventLog } from "@/lib/storybook/fixtures/goal"

const goal = makeGoal()

// The responsive detail surface (Sheet on desktop, Drawer on mobile) with four
// tabs. The Overview/Activity tabs read `chatGoalEvents`, so the Open story
// seeds a realistic log.
const meta = {
  title: "Goal/GoalDetailSheet",
  component: GoalDetailSheet,
  args: { goal, open: true, onOpenChange: fn() },
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.chatGoalEvents.bulkAdd(makeGoalEventLog(goal.id))
    })
  },
} satisfies Meta<typeof GoalDetailSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const CompletedGoal: Story = {
  args: { goal: makeGoal({ status: "completed", endedAt: goal.updatedAt }) },
}

export const Closed: Story = {
  args: { open: false },
}
