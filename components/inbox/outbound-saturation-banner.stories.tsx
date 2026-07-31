import type { Meta, StoryObj } from "@storybook/nextjs"

import { OutboundSaturationNotice } from "./outbound-saturation-banner"

// A pure presenter. `useOutboundSaturation` counts `outbound.queue_capped`
// audit rows per adapter over 24h and only reports those at or above the
// 100-row threshold; below it the list arrives empty and nothing renders.
const meta = {
  title: "Inbox/OutboundSaturationNotice",
  component: OutboundSaturationNotice,
  args: { onDismiss: () => {} },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof OutboundSaturationNotice>

export default meta
type Story = StoryObj<typeof meta>

export const Saturated: Story = {
  args: {
    adapters: [{ adapterId: "slack-acme", cappedCount: 120, lastAt: Date.now() }],
  },
}

export const MultipleAdapters: Story = {
  args: {
    adapters: [
      { adapterId: "slack-acme", cappedCount: 340, lastAt: Date.now() },
      { adapterId: "telegram-ops", cappedCount: 105, lastAt: Date.now() - 60_000 },
    ],
  },
}

// Below the 100-row threshold the hook reports nothing → renders nothing.
export const BelowThreshold: Story = {
  args: { adapters: [] },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing below threshold → <OutboundSaturationNotice {...args} />
    </div>
  ),
}
