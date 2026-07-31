import type { Meta, StoryObj } from "@storybook/nextjs"
import { ProviderStatusBadge } from "./provider-status-badge"

// Pure component: a small status pill. Reads only `next-intl` translations and
// props — every supported `ProviderStatus` value is covered below. The
// "unknown" status intentionally renders nothing (returns null).
const meta = {
  title: "Settings/Provider/ProviderStatusBadge",
  component: ProviderStatusBadge,
  args: {
    status: "connected",
  },
} satisfies Meta<typeof ProviderStatusBadge>
export default meta
type Story = StoryObj<typeof meta>

export const Connected: Story = {}

export const ConnectedWithLatency: Story = {
  args: { status: "connected", latency: 142 },
}

export const Testing: Story = {
  args: { status: "testing" },
}

export const Ready: Story = {
  args: { status: "ready" },
}

export const Stale: Story = {
  args: { status: "stale" },
}

export const Failed: Story = {
  args: { status: "failed" },
}

export const NotSet: Story = {
  args: { status: "not-set" },
}

export const Compact: Story = {
  args: { status: "connected", compact: true },
}

// Returns null — nothing renders.
export const UnknownRendersNothing: Story = {
  args: { status: "unknown" },
}
