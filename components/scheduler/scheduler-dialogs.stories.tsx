import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerDialogs } from "./scheduler-dialogs"
import { makeScheduledTask, makeSystemTask } from "@/lib/storybook/fixtures/scheduler"

// `SchedulerDialogs` is a pure collection of `Sheet` / `AlertDialog` surfaces,
// each gated by a boolean (or a non-null id). The meta defaults keep every
// surface closed; each story opens exactly one so it renders in isolation.
const meta = {
  title: "Scheduler/SchedulerDialogs",
  component: SchedulerDialogs,
  parameters: { layout: "fullscreen" },
  args: {
    showCreateSheet: false,
    onShowCreateSheetChange: fn(),
    onCreateTask: fn(),
    isSubmitting: false,

    showEditSheet: false,
    onShowEditSheetChange: fn(),
    onEditTask: fn(),
    selectedTask: undefined,

    showSystemCreateSheet: false,
    onShowSystemCreateSheetChange: fn(),
    onCreateSystemTask: fn(),
    systemSubmitting: false,

    showSystemEditSheet: false,
    onShowSystemEditSheetChange: fn(),
    onEditSystemTask: fn(),
    selectedSystemTask: null,

    systemDeleteTaskId: null,
    onSystemDeleteTaskIdChange: fn(),
    onSystemDeleteConfirm: fn(),

    pendingConfirmation: null,
    onConfirmPending: fn(),
    onCancelPending: fn(),

    showAdminDialog: false,
    onShowAdminDialogChange: fn(),
    onRequestElevation: fn(),
  },
} satisfies Meta<typeof SchedulerDialogs>

export default meta
type Story = StoryObj<typeof meta>

/** Create-task sheet open with the full `TaskForm`. */
export const CreateTask: Story = {
  args: {
    showCreateSheet: true,
    existingTasks: [makeScheduledTask({ id: "x1", name: "Existing task" })],
  },
}

/** Edit-task sheet open, pre-filled from the selected task. */
export const EditTask: Story = {
  args: {
    showEditSheet: true,
    selectedTask: makeScheduledTask({ id: "edit-me", name: "Daily digest" }),
    existingTasks: [
      makeScheduledTask({ id: "edit-me", name: "Daily digest" }),
      makeScheduledTask({ id: "other", name: "Other task" }),
    ],
  },
}

/** Create system-task sheet open. */
export const CreateSystemTask: Story = {
  args: {
    showSystemCreateSheet: true,
  },
}

/** Edit system-task sheet open, pre-filled from the selected system task. */
export const EditSystemTask: Story = {
  args: {
    showSystemEditSheet: true,
    selectedSystemTask: makeSystemTask({ name: "Nightly disk cleanup" }),
  },
}

/** Delete-confirmation alert for a system task. */
export const SystemDeleteConfirmation: Story = {
  args: {
    systemDeleteTaskId: "system-task-1",
  },
}

/** Admin-elevation dialog open. */
export const AdminElevation: Story = {
  args: {
    showAdminDialog: true,
  },
}
