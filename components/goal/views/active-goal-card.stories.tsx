import type { Meta, StoryObj } from "@storybook/nextjs"

import { ActiveGoalCard } from "./active-goal-card"
import { makeGoal } from "@/lib/storybook/fixtures/goal"

// Rich open-goal card with a status rail, twin progress meters, and inline
// controls. It reads the goal's event log from Dexie for the latest judge
// verdict — in Storybook the DB is empty, so the judge-reason line is omitted.
const meta = {
  title: "Goal/ActiveGoalCard",
  component: ActiveGoalCard,
  args: { goal: makeGoal(), variant: "card" },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActiveGoalCard>

export default meta
type Story = StoryObj<typeof meta>

export const Active: Story = {}

export const ManualContinue: Story = {
  args: { goal: makeGoal({ config: { ...makeGoal().config, manualContinue: true } }) },
}

export const Paused: Story = {
  args: { goal: makeGoal({ status: "paused" }) },
}

export const Compact: Story = {
  args: { variant: "compact" },
}

export const CompactPaused: Story = {
  args: { variant: "compact", goal: makeGoal({ status: "paused" }) },
}
