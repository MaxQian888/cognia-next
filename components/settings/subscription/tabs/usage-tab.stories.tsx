import type { Meta, StoryObj } from "@storybook/nextjs"

import { SubscriptionUsageTab } from "./usage-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// `SubscriptionUsageTab` is the full usage dashboard (window gauges, trend,
// per-model breakdown, cost chart, top sessions) built from the persisted
// `subscriptionUsage` / `sessionUsage` Dexie tables, and is `isTauri()`-gated.
// In the Storybook (non-Tauri) browser it degrades to the "web mode" banner
// (`usage-web-banner`). Reset the settings store between stories so the usage
// display mode can't leak in.
const meta = {
  title: "Settings/Subscription/Tabs/SubscriptionUsageTab",
  component: SubscriptionUsageTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
} satisfies Meta<typeof SubscriptionUsageTab>

export default meta
type Story = StoryObj<typeof meta>

export const WebMode: Story = {}
