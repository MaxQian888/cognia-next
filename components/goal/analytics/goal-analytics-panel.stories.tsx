import type { Meta, StoryObj } from "@storybook/nextjs"

import { GoalAnalyticsPanel } from "./goal-analytics-panel"
import { GOAL_NOW, makeGoalSet } from "@/lib/storybook/fixtures/goal"

// Pure-data aggregates → a StatCard row + a status donut, a goals-created area
// chart, and a token-spend bar chart. `now` is injected so the timeline buckets
// render deterministically against the fixed fixture clock.
const meta = {
  title: "Goal/GoalAnalyticsPanel",
  component: GoalAnalyticsPanel,
  args: { goals: makeGoalSet(), now: GOAL_NOW },
  parameters: { layout: "padded" },
} satisfies Meta<typeof GoalAnalyticsPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

// `total === 0` renders the empty-state card instead of the charts.
export const Empty: Story = {
  args: { goals: [] },
}
