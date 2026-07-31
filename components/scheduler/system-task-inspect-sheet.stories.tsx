import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SystemTaskInspectSheet } from "./system-task-inspect-sheet"
import { makeSystemTask, makeSystemTaskTrigger } from "@/lib/storybook/fixtures/scheduler"

// `SystemTaskInspectSheet` is a pure controlled `Sheet` that renders a read-only
// platform-vs-metadata comparison for a system task. Stories render it OPEN.
const meta = {
  title: "Scheduler/SystemTaskInspectSheet",
  component: SystemTaskInspectSheet,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof SystemTaskInspectSheet>

export default meta
type Story = StoryObj<typeof meta>

/** A fully-resolved task with Edit + Delete actions in the footer. */
export const WithActions: Story = {
  args: {
    task: makeSystemTask(),
    onRequestEdit: fn(),
    onRequestDelete: fn(),
  },
}

/** No footer actions supplied — read-only inspection only. */
export const ReadOnly: Story = {
  args: {
    task: makeSystemTask(),
  },
}

/** A degraded task — surfaces the amber degradation-reasons banner. */
export const Degraded: Story = {
  args: {
    task: makeSystemTask({
      name: "Orphaned cleanup task",
      metadata_state: "degraded",
      degraded_reasons: [
        "Metadata store is missing the original action definition.",
        "Platform reports a trigger the app cannot edit.",
      ],
    }),
    onRequestEdit: fn(),
    onRequestDelete: fn(),
  },
}

/** Incomplete metadata — the metadata column collapses to placeholders. */
export const IncompleteMetadata: Story = {
  args: {
    task: makeSystemTask({
      name: "Boot-time indexer",
      metadata_state: "degraded",
      trigger: makeSystemTaskTrigger({ type: "on_boot", delay_seconds: 30 }),
    }),
  },
}
