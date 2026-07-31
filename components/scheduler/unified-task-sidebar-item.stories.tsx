import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { UnifiedTaskSidebarItem } from "./unified-task-sidebar-item"
import { makeUnifiedItem } from "@/lib/storybook/fixtures/scheduler"

// `UnifiedTaskSidebarItem` is a pure, capability-driven row that renders any
// `UnifiedScheduledItem` kind (app / workflow / backup / plugin / system /
// connector). The dropdown menu, multi-select checkbox, and "open in source
// editor" affordance are all gated by `capabilities` and the supplied
// callbacks, so stories vary kind, status, selection, and capability sets.
const meta = {
  title: "Scheduler/UnifiedTaskSidebarItem",
  component: UnifiedTaskSidebarItem,
  parameters: { layout: "centered" },
  args: {
    isActive: false,
    onClick: fn(),
    onRunNow: fn(),
    onPause: fn(),
    onResume: fn(),
    onEdit: fn(),
    onDelete: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-72 rounded-md border bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UnifiedTaskSidebarItem>

export default meta
type Story = StoryObj<typeof meta>

export const AppKind: Story = {
  args: {
    item: makeUnifiedItem({ kind: "app", name: "Overnight digest", status: "active" }),
  },
}

export const Selected: Story = {
  args: {
    item: makeUnifiedItem({ kind: "app", name: "Currently open task", status: "active" }),
    isActive: true,
  },
}

export const WorkflowKind: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "workflow",
      name: "Nightly ETL workflow",
      status: "active",
      triggerSummary: { type: "interval", intervalMs: 6 * 60 * 60_000 },
    }),
  },
}

export const BackupPaused: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "backup",
      name: "Weekly full backup",
      status: "paused",
      capabilities: { runNow: true, pause: true, edit: true, delete: false },
    }),
  },
}

export const PluginKind: Story = {
  args: {
    item: makeUnifiedItem({ kind: "plugin", name: "Clipboard sweep", status: "disabled" }),
  },
}

export const ConnectorOnceTrigger: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "connector",
      name: "Slack daily summary",
      status: "active",
      triggerSummary: { type: "once", runAtMs: Date.now() + 2 * 24 * 60 * 60_000 },
    }),
  },
}

// A system item that the user cannot edit — the dropdown swaps in an
// "open in source editor" deep link instead of an Edit action.
export const SystemReadOnly: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "system",
      name: "OS health check",
      status: "active",
      capabilities: { runNow: false, pause: false, edit: false, delete: true },
      triggerSummary: { type: "cron", cron: "0 */6 * * *" },
    }),
  },
}

// No callbacks + no capabilities → the row renders as a plain, action-less div.
export const NoActions: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "system",
      name: "Immutable system job",
      status: "unknown",
      capabilities: { runNow: false, pause: false, edit: false, delete: false },
    }),
    onRunNow: undefined,
    onPause: undefined,
    onResume: undefined,
    onEdit: undefined,
    onDelete: undefined,
  },
}

// Multi-select enabled: the hover-revealed checkbox is shown checked.
export const MultiSelectChecked: Story = {
  args: {
    item: makeUnifiedItem({ kind: "app", name: "Selected for bulk action", status: "active" }),
    isSelected: true,
    onToggleSelect: fn(),
  },
}
