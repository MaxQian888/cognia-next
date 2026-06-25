import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { StatusBadge } from "./status-badge"

// Reuse a namespace that already has status labels so t(value) resolves.
const meta = {
  title: "Shared/StatusBadge",
  component: StatusBadge,
  args: { labelNamespace: "agentRuns.status", value: "running" },
} satisfies Meta<typeof StatusBadge>

export default meta
type Story = StoryObj<typeof meta>

// default variant (positive / active)
export const Positive: Story = { args: { value: "succeeded" } }
// outline variant (neutral)
export const Neutral: Story = { args: { value: "paused" } }
// destructive variant
export const Destructive: Story = { args: { value: "failed" } }

export const WithPulse: Story = { args: { value: "running", pulse: true } }

// Missing keys fall back to the raw value rather than throwing.
export const RawFallback: Story = {
  args: { value: "some-unmapped-state", labelNamespace: "agentRuns.status" },
}

export const VariantMatrix: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {(["succeeded", "running", "paused", "pending", "failed", "cancelled"] as const).map((v) => (
        <StatusBadge key={v} labelNamespace="agentRuns.status" value={v} />
      ))}
    </div>
  ),
}
