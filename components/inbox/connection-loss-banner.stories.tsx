import type { Meta, StoryObj } from "@storybook/nextjs"

import { ConnectionLossNotice } from "./connection-loss-banner"

// A pure presenter: `useDegradedAdapters` groups recent (<5 min)
// `connectorHeartbeats` by adapter and keeps only those whose newest snapshot
// is `degraded` / `down`, then `InboxNoticeArea` decides whether to mount this.
// The stories drive it straight from props. Reconnect is Tauri-only (disabled
// in web, which is what Storybook renders).
const meta = {
  title: "Inbox/ConnectionLossNotice",
  component: ConnectionLossNotice,
  args: { onDismiss: () => {} },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ConnectionLossNotice>

export default meta
type Story = StoryObj<typeof meta>

export const SingleDegraded: Story = {
  args: {
    adapters: [
      {
        adapterId: "slack-acme",
        state: "degraded",
        reason: "websocket reconnecting",
        at: Date.now() - 10_000,
      },
    ],
  },
}

export const MultipleDown: Story = {
  args: {
    adapters: [
      { adapterId: "slack-acme", state: "down", reason: "auth expired", at: Date.now() - 10_000 },
      {
        adapterId: "telegram-ops",
        state: "degraded",
        reason: "rate limited upstream",
        at: Date.now() - 5_000,
      },
    ],
  },
}

// No reason on the heartbeat → the row shows the state alone.
export const NoReason: Story = {
  args: {
    adapters: [{ adapterId: "slack-acme", state: "down", reason: null, at: Date.now() }],
  },
}

// Every adapter healthy → the notice area never mounts this.
export const Healthy: Story = {
  args: { adapters: [] },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing when healthy → <ConnectionLossNotice {...args} />
    </div>
  ),
}
