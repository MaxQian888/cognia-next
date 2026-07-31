import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { SlaBadge } from "./sla-badge"

const NOW = Date.now()

const meta = {
  title: "Inbox/SlaBadge",
  component: SlaBadge,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SlaBadge>

export default meta
type Story = StoryObj<typeof meta>

export const DueInHours: Story = {
  args: { nextResponseDueAt: NOW + 2 * 60 * 60 * 1000 },
}

export const DueInMinutes: Story = {
  args: { nextResponseDueAt: NOW + 45 * 60 * 1000 },
}

export const Overdue: Story = {
  args: { nextResponseDueAt: NOW - 60 * 60 * 1000 },
}

// Self-hides with no deadline (or when resolved).
export const Hidden: Story = {
  args: { nextResponseDueAt: undefined },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <SlaBadge {...args} />
    </div>
  ),
}
