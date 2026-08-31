import type { Meta, StoryObj } from "@storybook/nextjs"

import { TaskWorkspaceMove } from "./task-workspace-move"
import { useProjectStore } from "@/stores/project/project-store"
import type { ScheduledTask } from "@/types/scheduler"

function seed() {
  useProjectStore.setState({
    projects: [
      { id: "ws_a", name: "Cognia" },
      { id: "ws_b", name: "Backend API" },
      { id: "ws_c", name: "Marketing site" },
    ] as never,
    activeProjectId: "ws_a",
    loaded: true,
  })
}

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "Nightly digest",
    status: "active",
    projectId: "ws_a",
    ...over,
  } as ScheduledTask
}

const meta: Meta<typeof TaskWorkspaceMove> = {
  title: "Scheduler/TaskWorkspaceMove",
  component: TaskWorkspaceMove,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => {
      seed()
      return (
        <div className="w-[420px] rounded-lg border p-4">
          <Story />
        </div>
      )
    },
  ],
}
export default meta

type Story = StoryObj<typeof TaskWorkspaceMove>

/** The ordinary case: a schedule bound to a workspace that exists. */
export const Bound: Story = { args: { task: task() } }

/** A schedule that belongs to every workspace, which is where pre-v5 rows sit. */
export const Unbound: Story = { args: { task: task({ projectId: undefined }) } }

/**
 * Bound to a workspace that was deleted.
 *
 * Radix blanks the trigger for a value with no matching item, which would make
 * this indistinguishable from Unbound, so the dangling id is named.
 */
export const MissingWorkspace: Story = { args: { task: task({ projectId: "ws_deleted" }) } }
