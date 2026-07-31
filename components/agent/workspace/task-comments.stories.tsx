import type { Meta, StoryObj } from "@storybook/nextjs"

import { TaskComments } from "./task-comments"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeamTask } from "@/types/agent/agent-team"

const withComments: AgentTeamTask = {
  id: "task-1",
  teamId: "team-1",
  title: "Patch computePlanCounts",
  description: "Fix the off-by-one in the reducer.",
  status: "in_progress",
  priority: "critical",
  dependencies: [],
  tags: [],
  order: 0,
  createdAt: new Date("2026-06-29T10:00:00.000Z"),
  comments: [
    {
      id: "c1",
      taskId: "task-1",
      authorId: "tm-coder",
      authorName: "Coder",
      text: "Reproduced with seed **42**. Root cause is the `<=` in the loop guard.",
      createdAt: new Date("2026-06-29T10:05:00.000Z"),
      attachments: [
        { id: "a1", name: "patch.diff", kind: "file", ref: "fix/patch.diff" },
        { id: "a2", name: "issue #128", kind: "link", ref: "https://example.com/issues/128" },
      ],
    },
    {
      id: "c2",
      taskId: "task-1",
      authorId: "user",
      authorName: "You",
      text: "Looks right — please add a regression test before completing.",
      createdAt: new Date("2026-06-29T10:08:00.000Z"),
    },
  ],
}

const emptyTask: AgentTeamTask = { ...withComments, id: "task-2", comments: [] }

const meta = {
  title: "Agent/Workspace/TaskComments",
  component: TaskComments,
  beforeEach: () => {
    resetStore(useAgentTeamStore)
    seedStore(useAgentTeamStore, {
      tasks: { "task-1": withComments, "task-2": emptyTask },
    })
  },
} satisfies Meta<typeof TaskComments>

export default meta
type Story = StoryObj<typeof meta>

// A thread with teammate + operator comments and attachment chips.
export const WithThread: Story = {
  args: { taskId: "task-1" },
}

// No comments yet — empty hint + composer.
export const Empty: Story = {
  args: { taskId: "task-2" },
}
