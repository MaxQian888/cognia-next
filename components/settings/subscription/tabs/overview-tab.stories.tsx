import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SubscriptionOverviewTab } from "./overview-tab"

// `SubscriptionOverviewTab` renders the live status badge + 5h/7d utilization
// bars for the active Anthropic account, and is `isTauri()`-gated. In the
// Storybook (non-Tauri) browser it degrades to the "web mode" banner.
// `onRequestAddAccount` drives the signed-out empty-state CTA.
const meta = {
  title: "Settings/Subscription/Tabs/SubscriptionOverviewTab",
  component: SubscriptionOverviewTab,
  args: { onRequestAddAccount: fn() },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SubscriptionOverviewTab>

export default meta
type Story = StoryObj<typeof meta>

export const WebMode: Story = {}
