import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentTeamTasks } from "./tasks"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildTeammate } from "@/lib/storybook/fixtures/agent-team"
import type { AgentTeamTask } from "@/types/agent/agent-team"

const teammates = [buildTeammate({ id: "tm-coder", name: "Coder", role: "teammate" })]

const tasks: AgentTeamTask[] = [
  {
    id: "task-1",
    teamId: "team-1",
    title: "Reproduce the failing test",
    description: "Run plan-reducer.test.ts and capture the seed.",
    status: "completed",
    priority: "high",
    dependencies: [],
    tags: ["repro"],
    assignedTo: "tm-coder",
    result: "Reproduced with seed 42.",
    order: 0,
    createdAt: new Date("2026-06-29T10:00:00.000Z"),
  },
  {
    id: "task-2",
    teamId: "team-1",
    title: "Patch computePlanCounts",
    description: "Fix the off-by-one in the reducer.",
    status: "in_progress",
    priority: "critical",
    dependencies: ["task-1"],
    tags: ["fix"],
    assignedTo: "tm-coder",
    order: 1,
    createdAt: new Date("2026-06-29T10:01:00.000Z"),
  },
]

const meta = {
  title: "Agent/Workspace/Tasks",
  component: AgentTeamTasks,
  args: { teamId: "team-1", tasks, teammates },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof AgentTeamTasks>

export default meta
type Story = StoryObj<typeof meta>

// Task list with status + priority + assignee.
export const WithTasks: Story = {}

// No tasks → empty state with a create CTA.
export const Empty: Story = {
  args: { tasks: [] },
}
