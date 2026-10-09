import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalsMobileBody } from "./goals-mobile-body"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeGoal, makeGoalSet } from "@/lib/storybook/fixtures/goal"

// Mobile Goals view. Reads the workspace goals live from Dexie, shows a
// count strip (active / paused / completed of finished), a "Needs you" list
// for goals awaiting a verdict, and opens `GoalDetailSheet` on tap. With an
// empty DB it renders zeroed stats + an empty state.
const meta = {
  title: "Mobile/Goals/GoalsMobileBody",
  component: GoalsMobileBody,
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    await seedDb(async () => {})
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoalsMobileBody>

export default meta
type Story = StoryObj<typeof meta>

/** No goals synced — zeroed stat tiles + empty state. */
export const Empty: Story = {}

/** Open goals, one awaiting acceptance, and a finished history. */
export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.chatGoals.bulkAdd([
        ...makeGoalSet(),
        makeGoal({
          id: "goal_awaiting",
          sessionId: "ses_awaiting",
          rawObjective: "Draft the Q3 roadmap summary",
          safeObjective: "Draft the Q3 roadmap summary",
          status: "paused",
          awaitingAcceptance: true,
        }),
      ])
    })
  },
}
