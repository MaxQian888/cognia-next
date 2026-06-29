import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AgentRunsPanel } from "./agent-runs-panel"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeGoalSet } from "@/lib/storybook/fixtures/goal"

// Master-detail panel of live + recent goal / team / plan / scheduled runs, with
// kind filters. It fans in several Dexie sources via `useAgentRuns`; the
// populated story seeds `chatGoals` so goal-kind runs appear.
const meta = {
  title: "AgentRuns/AgentRunsPanel",
  component: AgentRunsPanel,
  args: { onSelect: fn(), onFilterKind: fn(), filterKind: "all" },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[560px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentRunsPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.chatGoals.bulkAdd(makeGoalSet())
    })
  },
}

export const GoalsFilter: Story = {
  args: { filterKind: "goal" },
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
