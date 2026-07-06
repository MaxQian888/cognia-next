import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import {
  QuickWorkflowTriggerDialog,
  type QuickWorkflowTriggerDialogProps,
} from "./quick-workflow-trigger-dialog"

// `QuickWorkflowTriggerDialog` adds a `trigger.cron` node to an existing
// workflow without opening the full editor. It reads the workflow list via
// Dexie `useLiveQuery`, but accepts `db` / `syncFn` / `newNodeId` injection
// hooks (used by tests) — so stories pass a deterministic in-memory `db` stub
// and a spy `syncFn` instead of touching IndexedDB. Rendered `open`.
type DbStub = NonNullable<QuickWorkflowTriggerDialogProps["db"]>

function makeDbStub(workflows: Array<{ id: string; name: string }>): DbStub {
  return {
    workflows: {
      toArray: async () => workflows,
      get: async (id: string) => workflows.find((w) => w.id === id),
      put: async () => undefined,
    },
    workflowTriggers: {
      put: async () => undefined,
    },
  } as unknown as DbStub
}

const populatedDb = makeDbStub([
  { id: "wf-etl", name: "Nightly ETL" },
  { id: "wf-digest", name: "Morning digest" },
  { id: "wf-cleanup", name: "Weekly cleanup" },
])

const emptyDb = makeDbStub([])

const meta = {
  title: "Scheduler/QuickWorkflowTriggerDialog",
  component: QuickWorkflowTriggerDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: fn(),
    onCreated: fn(),
    syncFn: fn(async () => {}),
    newNodeId: () => "trigger_story_fixed",
  },
} satisfies Meta<typeof QuickWorkflowTriggerDialog>

export default meta
type Story = StoryObj<typeof meta>

// Several workflows available — the combobox is populated and the default
// daily-9am preset resolves to a cron expression.
export const WithWorkflows: Story = {
  args: {
    db: populatedDb,
  },
}

// No workflows yet — the combobox is empty and submit stays disabled until a
// workflow is picked.
export const NoWorkflows: Story = {
  args: {
    db: emptyDb,
  },
}
