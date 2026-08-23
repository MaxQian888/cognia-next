import type { Meta, StoryObj } from "@storybook/nextjs"

import { ExecutionStatusPill } from "./agent-run-status-pill"
import type { UnifiedExecutionStatus } from "@/lib/execution/monitor-model"

const meta = {
  title: "AgentRuns/ExecutionStatusPill",
  component: ExecutionStatusPill,
} satisfies Meta<typeof ExecutionStatusPill>

export default meta
type Story = StoryObj<typeof meta>

const STATUSES: UnifiedExecutionStatus[] = [
  "queued",
  "running",
  "waiting",
  "done",
  "error",
  "cancelled",
]

export const Running: Story = { args: { status: "running" } }

/**
 * Every status side by side. `queued` and `cancelled` deliberately share the
 * muted treatment — neither is an alarm — while `waiting` is amber because it
 * is the one that needs a person.
 */
export const AllStatuses: Story = {
  args: { status: "running" },
  render: () => (
    <div className="flex flex-wrap gap-2">
      {STATUSES.map((status) => (
        <ExecutionStatusPill key={status} status={status} />
      ))}
    </div>
  ),
}
