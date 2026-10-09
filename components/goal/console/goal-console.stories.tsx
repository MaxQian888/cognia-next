import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { GoalConsole, type GoalConsoleProps } from "./goal-console"
import type { GoalConsoleLocation } from "@/lib/goal/console-prefs"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeGoal, makeGoalSet } from "@/lib/storybook/fixtures/goal"

// The `/goals` console: a FeaturePageShell whose header carries the tabs
// (Overview / History / Analytics / Configure) inline, one section in the
// center, and the selected goal as the inspector pane beside it. The route
// owns the address (`?tab=` / `?section=` / `?goal=`); here a small host keeps
// it in state so tab switches and selection behave as they do in the app, and
// still reports every `onNavigate` to the Actions panel.
function RoutedConsole({ location, selectedGoalId, onNavigate }: GoalConsoleProps) {
  const [place, setPlace] = useState<{
    location: GoalConsoleLocation | null
    goalId: string | null
  }>({ location, goalId: selectedGoalId })
  return (
    <GoalConsole
      location={place.location}
      selectedGoalId={place.goalId}
      onNavigate={(next, options) => {
        onNavigate(next, options)
        setPlace({
          location: { tab: next.tab, section: next.section },
          goalId: next.goalId ?? null,
        })
      }}
    />
  )
}

const seedGoals = async () => {
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
}

const meta = {
  title: "Goal/GoalConsole",
  component: GoalConsole,
  render: (args) => <RoutedConsole {...args} />,
  args: {
    location: null,
    selectedGoalId: null,
    onNavigate: fn(),
  },
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

/** Overview: lifetime strip, "Needs you", and the open goals. */
export const Populated: Story = {
  beforeEach: seedGoals,
}

/** A goal selected into the inspector pane. */
export const WithInspector: Story = {
  args: { location: { tab: "overview" }, selectedGoalId: "goal_1" },
  beforeEach: seedGoals,
}

export const History: Story = {
  args: { location: { tab: "history" } },
  beforeEach: seedGoals,
}

export const Analytics: Story = {
  args: { location: { tab: "analytics" } },
  beforeEach: seedGoals,
}

export const Configure: Story = {
  args: { location: { tab: "config", section: "templates" } },
  beforeEach: seedGoals,
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
