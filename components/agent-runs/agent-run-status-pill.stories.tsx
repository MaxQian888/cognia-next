import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { AgentRunStatusPill } from "./agent-run-status-pill"

const meta = {
  title: "AgentRuns/AgentRunStatusPill",
  component: AgentRunStatusPill,
} satisfies Meta<typeof AgentRunStatusPill>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = { args: { status: "running" } }
export const Paused: Story = { args: { status: "paused" } }
export const Succeeded: Story = { args: { status: "succeeded" } }
export const Failed: Story = { args: { status: "failed" } }
export const Cancelled: Story = { args: { status: "cancelled" } }

export const AllStatuses: Story = {
  args: { status: "running" },
  render: () => (
    <div className="flex flex-wrap gap-2">
      {(["running", "paused", "succeeded", "failed", "cancelled"] as const).map((s) => (
        <AgentRunStatusPill key={s} status={s} />
      ))}
    </div>
  ),
}
