import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DetailHeader } from "./detail-header"
import { makeUnifiedItem } from "@/lib/storybook/fixtures/scheduler"

// `DetailHeader` is a pure presentational header for the unified-detail
// sub-views: it renders the kind icon, name/description, a status badge, and
// only the action buttons the item's `capabilities` permit. All mutations are
// delegated to callbacks, so stories wire `fn()` spies and vary the item's
// `kind`, `status`, and `capabilities` to exercise every action permutation.
const meta = {
  title: "Scheduler/Details/DetailHeader",
  component: DetailHeader,
  parameters: { layout: "fullscreen" },
  args: {
    onRunNow: fn(),
    onPause: fn(),
    onResume: fn(),
    onEdit: fn(),
    onDelete: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl border rounded-md bg-card">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DetailHeader>

export default meta
type Story = StoryObj<typeof meta>

// App task, active, every capability enabled → all four actions render.
export const AppFullCapabilities: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "app",
      name: "Overnight digest",
      description: "Summarize overnight activity and post a digest.",
      status: "active",
      capabilities: { runNow: true, pause: true, edit: true, delete: true },
    }),
  },
}

// Paused item → the pause/resume button flips to "Resume".
export const BackupPaused: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "backup",
      name: "Weekly full backup",
      description: "Encrypted snapshot of the local vault.",
      status: "paused",
      capabilities: { runNow: true, pause: true, edit: true, delete: false },
    }),
  },
}

export const WorkflowActive: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "workflow",
      name: "Nightly ETL workflow",
      description: "Extract, transform, and load the analytics tables.",
      status: "active",
    }),
  },
}

export const PluginActive: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "plugin",
      name: "Clipboard sweep",
      status: "active",
    }),
  },
}

// System (OS) task — read-mostly: only delete is permitted, so the run/pause/
// edit buttons are suppressed.
export const SystemDeleteOnly: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "system",
      name: "OS health check",
      description: "Platform-managed maintenance task.",
      status: "active",
      capabilities: { runNow: false, pause: false, edit: false, delete: true },
    }),
  },
}

export const ConnectorExpired: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "connector",
      name: "Slack daily summary",
      description: "One-shot digest pushed to the #standup channel.",
      status: "expired",
    }),
  },
}

// No capabilities at all → header renders with zero action buttons.
export const NoActions: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "app",
      name: "Read-only mirror",
      status: "disabled",
      capabilities: { runNow: false, pause: false, edit: false, delete: false },
    }),
  },
}

// Item without a description → the description line is omitted.
export const NoDescription: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "app",
      name: "Untitled job",
      description: undefined,
      status: "unknown",
    }),
  },
}
