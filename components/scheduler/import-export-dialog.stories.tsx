import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ExportTasksDialog, ImportTasksDialog } from "./import-export-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"

// `import-export-dialog` exports two scheduler-store-backed dialogs:
// `ExportTasksDialog` (scope: all / selected) and `ImportTasksDialog` (file +
// merge/replace mode). Both take a controlled `open` prop, so they render open
// directly. We seed `isInitialized: true` so the store's initialize effect is
// inert in Storybook.
const meta = {
  title: "Scheduler/ImportExportDialog",
  component: ExportTasksDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: fn(),
  },
  beforeEach: () => {
    resetStore(useSchedulerStore)
    seedStore(useSchedulerStore, { isInitialized: true })
  },
} satisfies Meta<typeof ExportTasksDialog>

export default meta
type Story = StoryObj<typeof meta>

// Export with no selection — only the "all tasks" option is offered.
export const ExportAll: Story = {}

// Export with a multi-selection — the "selected" radio appears with a count.
export const ExportWithSelection: Story = {
  args: {
    selectedTaskIds: new Set(["task-1", "task-2", "task-3"]),
  },
}

// The import dialog (separate component) in its default merge mode, before a
// file has been chosen — the import button stays disabled.
export const ImportDefault: StoryObj<typeof ImportTasksDialog> = {
  render: (args) => <ImportTasksDialog {...args} />,
  args: {
    open: true,
    onOpenChange: fn(),
  },
}
