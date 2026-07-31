import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ConnectorPolicySheet, type ConnectorPolicy } from "./connector-policy-sheet"

// Connector policy editor sheet (default mode / mute / quiet hours). Pure: the
// form seeds from `policy` on open and renders null when `policy` is null. The
// optimistic Dexie write + outbound enqueue only run on Save.
const withQuietHours: ConnectorPolicy = {
  id: "adapter-slack-1",
  displayName: "Slack · #support",
  defaultMode: "draft",
  muted: false,
  quietHours: { from: "22:00", to: "07:00", tz: "UTC" },
}

const meta = {
  title: "Mobile/Connector/ConnectorPolicySheet",
  component: ConnectorPolicySheet,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof ConnectorPolicySheet>

export default meta
type Story = StoryObj<typeof meta>

/** Draft mode with a configured quiet-hours window. */
export const WithQuietHours: Story = {
  args: { policy: withQuietHours },
}

/** Auto mode, muted, no quiet hours. */
export const MutedAuto: Story = {
  args: {
    policy: {
      id: "adapter-telegram-1",
      displayName: "Telegram · DM",
      defaultMode: "auto",
      muted: true,
    },
  },
}
