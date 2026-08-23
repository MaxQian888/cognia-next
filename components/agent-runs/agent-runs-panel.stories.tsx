import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AgentRunsPanel } from "./agent-runs-panel"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeGoalSet } from "@/lib/storybook/fixtures/goal"

// The task cockpit: a master-detail view over every execution kind, with status
// and kind filters. It fans the run journal in through `useExecutionCockpit`;
// the seeded stories write `chatGoals`, which reach the list through the legacy
// adapter (no journal rows exist in a fresh Storybook database), so they also
// exercise the "no controls on an un-journalled run" path.
const meta = {
  title: "AgentRuns/AgentRunsPanel",
  component: AgentRunsPanel,
  args: {
    onSelect: fn(),
    onFilterKind: fn(),
    onStatusGroup: fn(),
    filterKind: "all",
    statusGroup: "all",
  },
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

/** The status filter is the cockpit's primary axis — this is its failed bucket. */
export const FailedOnly: Story = {
  args: { statusGroup: "failed" },
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
