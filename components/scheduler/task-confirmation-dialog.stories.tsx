import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TaskConfirmationDialog, AdminElevationDialog } from "./task-confirmation-dialog"
import { FIXTURE_NOW } from "@/lib/storybook/fixtures/scheduler"
import type { TaskConfirmationRequest } from "@/types/scheduler"

// `TaskConfirmationDialog` is a pure, props-only AlertDialog gating sensitive
// scheduler operations. The risk level drives the icon, badge variant, and —
// for `critical` — an "I understand the risks" checkbox that the confirm
// button waits on. Rendered `open` so the body is visible.
const createdAt = new Date(FIXTURE_NOW).toISOString()
const expiresAt = new Date(FIXTURE_NOW + 5 * 60_000).toISOString()

function makeConfirmation(over: Partial<TaskConfirmationRequest> = {}): TaskConfirmationRequest {
  return {
    confirmation_id: "conf-7f3a",
    target_task_id: "system-task-1",
    operation: "create",
    risk_level: "low",
    requires_admin: false,
    warnings: [],
    details: {
      task_name: "Nightly disk cleanup",
      action_summary: "Run /usr/bin/cleanup --rotate-logs as the current user.",
      trigger_summary: "Every day at 02:00 (UTC)",
    },
    created_at: createdAt,
    expires_at: expiresAt,
    ...over,
  }
}

const meta = {
  title: "Scheduler/TaskConfirmationDialog",
  component: TaskConfirmationDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onConfirm: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof TaskConfirmationDialog>

export default meta
type Story = StoryObj<typeof meta>

// Low-risk create — green shield, plain confirm button, no extra gating.
export const LowRisk: Story = {
  args: {
    confirmation: makeConfirmation({ risk_level: "low", operation: "create" }),
  },
}

// High-risk update with warnings — orange shield, destructive confirm, and a
// warning list.
export const HighRiskWithWarnings: Story = {
  args: {
    confirmation: makeConfirmation({
      risk_level: "high",
      operation: "update",
      warnings: [
        "This task runs with administrator privileges.",
        "The schedule overlaps an existing maintenance window.",
      ],
    }),
  },
}

// Critical delete — requires the "I understand the risks" checkbox before the
// (destructive) confirm button enables. Includes a script preview block.
export const CriticalWithScriptPreview: Story = {
  args: {
    confirmation: makeConfirmation({
      risk_level: "critical",
      operation: "delete",
      requires_admin: true,
      warnings: ["Deleting this task removes its execution history permanently."],
      details: {
        task_name: "Production backup rotation",
        action_summary: "Delete the scheduled task and its OS-level registration.",
        trigger_summary: "Every Sunday at 03:00 (UTC)",
        script_preview:
          "#!/usr/bin/env bash\nset -euo pipefail\nrm -rf /var/backups/cognia/*\necho 'rotation complete'",
      },
    }),
  },
}

// Loading state — confirm/cancel disabled while the operation is in flight.
export const Processing: Story = {
  args: {
    confirmation: makeConfirmation({ risk_level: "medium", operation: "enable" }),
    loading: true,
  },
}

// The companion admin-elevation dialog (separate exported component) prompting
// the user to relaunch elevated.
export const AdminElevation: StoryObj<typeof AdminElevationDialog> = {
  render: (args) => <AdminElevationDialog {...args} />,
  args: {
    open: true,
    onRequestElevation: fn(),
    onCancel: fn(),
  },
}
