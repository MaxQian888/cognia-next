import type { Meta, StoryObj } from "@storybook/nextjs"

import { RunStatusBadge } from "./run-status-badge"
import type { RunStatus } from "@/types/workflow/visual"

// Colored status pill for a workflow run. Pure — one prop drives both the
// label (i18n) and the color treatment.
const meta = {
  title: "Mobile/Workflow/RunStatusBadge",
  component: RunStatusBadge,
  parameters: { layout: "centered" },
  args: { status: "succeeded" },
} satisfies Meta<typeof RunStatusBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Succeeded: Story = {}
export const Running: Story = { args: { status: "running" } }
export const Failed: Story = { args: { status: "failed" } }
export const Waiting: Story = { args: { status: "waiting" } }

const ALL: RunStatus[] = [
  "pending",
  "running",
  "waiting",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
]

export const AllStatuses: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {ALL.map((status) => (
        <RunStatusBadge key={status} status={status} />
      ))}
    </div>
  ),
}
