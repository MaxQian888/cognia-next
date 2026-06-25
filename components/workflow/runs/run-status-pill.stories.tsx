import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { RunStatusPill } from "./run-status-pill"
import type { RunStatus } from "@/types/workflow/visual"

const STATUSES: RunStatus[] = [
  "pending",
  "running",
  "waiting",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
]

const meta = {
  title: "Workflow/RunStatusPill",
  component: RunStatusPill,
  args: { status: "running" },
} satisfies Meta<typeof RunStatusPill>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {}

export const AllStatuses: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {STATUSES.map((s) => (
        <RunStatusPill key={s} status={s} />
      ))}
    </div>
  ),
}

export const WithoutIcon: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {STATUSES.map((s) => (
        <RunStatusPill key={s} status={s} showIcon={false} />
      ))}
    </div>
  ),
}
