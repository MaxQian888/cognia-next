import type { Meta, StoryObj } from "@storybook/nextjs"

import { TeamRunsList } from "./runs-list"
import { seedDb } from "@/lib/storybook/seed-db"

const meta = {
  title: "Agent/Team/RunsList",
  component: TeamRunsList,
  args: { teamId: "team-1" },
} satisfies Meta<typeof TeamRunsList>

export default meta
type Story = StoryObj<typeof meta>

// Empty IndexedDB → the "no runs" empty state.
export const Empty: Story = {}

// Seeds two team-scoped workflowRuns (one succeeded, one failed).
export const WithRuns: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.workflowRuns.bulkPut([
        {
          id: "run-success",
          workflowId: "wf-team-1",
          status: "succeeded",
          triggerKind: "trigger.team",
          triggerPayload: { teamId: "team-1" },
          startedAt: Date.UTC(2026, 5, 29, 10),
          completedAt: Date.UTC(2026, 5, 29, 10, 5),
        },
        {
          id: "run-failed",
          workflowId: "wf-team-1",
          status: "failed",
          triggerKind: "trigger.team",
          triggerPayload: { teamId: "team-1" },
          startedAt: Date.UTC(2026, 5, 29, 11),
          completedAt: Date.UTC(2026, 5, 29, 11, 2),
          error: { message: "Teammate dispatch timed out" },
        },
      ] as unknown as Parameters<typeof db.workflowRuns.bulkPut>[0])
    })
  },
}
