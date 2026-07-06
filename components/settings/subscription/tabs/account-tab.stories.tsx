import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SubscriptionAccountTab } from "./account-tab"

// `SubscriptionAccountTab` surfaces the active Anthropic credential (email /
// plan / expiry) with refresh + sign-out actions, and is `isTauri()`-gated. In
// the Storybook (non-Tauri) browser it degrades to the "web mode" banner.
// `onRequestAddAccount` drives the signed-out empty-state CTA (only reachable
// on desktop once the keychain is available).
const meta = {
  title: "Settings/Subscription/Tabs/SubscriptionAccountTab",
  component: SubscriptionAccountTab,
  args: { onRequestAddAccount: fn() },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SubscriptionAccountTab>

export default meta
type Story = StoryObj<typeof meta>

export const WebMode: Story = {}
