import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerBulkToolbar } from "./scheduler-bulk-toolbar"
import { makeUnifiedItem } from "@/lib/storybook/fixtures/scheduler"

// `SchedulerBulkToolbar` is props-only: it receives the already-selected
// `UnifiedScheduledItem[]` (the page owns the multi-selection state) and renders
// a sticky action strip. Pause/Resume buttons enable only when the selection
// has pausable items; Delete only when something is deletable. It returns null
// for an empty selection. The store-backed `getSchedulerSourceRegistry` is only
// touched on click, so display stories need no registry.
const meta = {
  title: "Scheduler/SchedulerBulkToolbar",
  component: SchedulerBulkToolbar,
  parameters: { layout: "fullscreen" },
  args: {
    onClearSelection: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-md border-x bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SchedulerBulkToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const SingleSelected: Story = {
  args: {
    selectedItems: [makeUnifiedItem({ kind: "app", name: "Overnight digest" })],
  },
}

export const MultipleSelected: Story = {
  args: {
    selectedItems: [
      makeUnifiedItem({ kind: "app", name: "Overnight digest" }),
      makeUnifiedItem({ kind: "workflow", name: "Nightly ETL workflow" }),
      makeUnifiedItem({ kind: "plugin", name: "Clipboard sweep" }),
    ],
  },
}

// Every selected item is non-pausable / non-deletable, so all action buttons
// are disabled while the count still reflects the selection.
export const AllActionsDisabled: Story = {
  args: {
    selectedItems: [
      makeUnifiedItem({
        kind: "system",
        name: "OS health check",
        capabilities: { runNow: false, pause: false, edit: false, delete: false },
      }),
      makeUnifiedItem({
        kind: "system",
        name: "Time sync",
        capabilities: { runNow: false, pause: false, edit: false, delete: false },
      }),
    ],
  },
}

// Mixed: some pausable, some deletable — buttons enable based on counts.
export const MixedCapabilities: Story = {
  args: {
    selectedItems: [
      makeUnifiedItem({
        kind: "app",
        name: "Pausable + deletable",
        capabilities: { runNow: true, pause: true, edit: true, delete: true },
      }),
      makeUnifiedItem({
        kind: "backup",
        name: "Pausable, not deletable",
        capabilities: { runNow: true, pause: true, edit: true, delete: false },
      }),
    ],
  },
}

// Empty selection renders nothing — the toolbar hides itself.
export const EmptySelectionHidden: Story = {
  args: {
    selectedItems: [],
  },
}
