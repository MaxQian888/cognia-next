import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ConnectorPolicySheet, type ConnectorPolicy } from "./connector-policy-sheet"

// Bot policy editor sheet — behaviour axes, mute, quiet hours, the host
// capability ceiling, and (behind a disclosure) the inbound trigger policy.
// Pure: the form seeds from `policy` on open and renders null when `policy` is
// null. The optimistic Dexie write + outbound enqueue only run on Save.
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

/**
 * Everything pinned: axes chosen rather than projected from the mode mirror,
 * A2UI forced off, two host capabilities clamped away. Each of these was a
 * live control here that the save silently discarded until the relay contract
 * grew fields for them.
 */
export const PinnedAndClamped: Story = {
  args: {
    policy: {
      id: "adapter-lark-1",
      displayName: "Lark · Ops",
      defaultMode: "manual",
      defaultAutonomy: "confirm",
      defaultEngagement: "background",
      defaultAuthority: "acceptEdits",
      inboundActivationPolicy: "always",
      activeRunDispatchMode: "steer",
      activationTtlMs: 7_200_000,
      a2uiEnabled: false,
      hostCapabilityCeiling: ["ocr", "goal_driving"],
      trigger: {
        rules: [{ kind: "self-mention" }, { kind: "keyword", words: ["deploy"], caseInsensitive: true }],
        blockers: [{ kind: "cooldown-after-bot-reply", secs: 45 }],
        storeUnmatchedInDraftMode: true,
      },
    },
  },
}
