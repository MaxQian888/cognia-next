import type { Meta, StoryObj } from "@storybook/nextjs"

import { PlanModeTasksSheet } from "./plan-mode-tasks-sheet"
import { seedDb } from "@/lib/storybook/seed-db"

const meta = {
  title: "Agent/Workspace/PlanModeTasksSheet",
  component: PlanModeTasksSheet,
  args: { sessionId: "session-1" },
} satisfies Meta<typeof PlanModeTasksSheet>

export default meta
type Story = StoryObj<typeof meta>

// No run record with todos → the trigger renders nothing.
export const NoTodos: Story = {}

// Seeds a run record with a todo snapshot → the trigger appears; click to open.
export const WithTodos: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.runRecords.put({
        sessionId: "session-1",
        runId: 1,
        startedAt: Date.UTC(2026, 5, 29, 10),
        settledAt: Date.UTC(2026, 5, 29, 10, 5),
        status: "completed",
        tools: [],
        subagents: [],
        todos: [
          { content: "Reproduce the failing test", status: "completed" },
          { content: "Patch the reducer", status: "in_progress" },
          { content: "Open a PR", status: "pending" },
        ],
        todoCounts: { done: 1, total: 3 },
        counts: { tools: 0, subagents: 0 },
      } as unknown as Parameters<typeof db.runRecords.put>[0])
    })
  },
}
