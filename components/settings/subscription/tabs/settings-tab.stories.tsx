import type { Meta, StoryObj } from "@storybook/nextjs"

import { SubscriptionSettingsTab } from "./settings-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// `SubscriptionSettingsTab` edits the Anthropic probe cadence / warning
// threshold (settings store) and embeds the custom-sources card, but is
// `isTauri()`-gated. In the Storybook (non-Tauri) browser it degrades to the
// "web mode" banner. Reset the settings store between stories.
const meta = {
  title: "Settings/Subscription/Tabs/SubscriptionSettingsTab",
  component: SubscriptionSettingsTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
} satisfies Meta<typeof SubscriptionSettingsTab>

export default meta
type Story = StoryObj<typeof meta>

export const WebMode: Story = {}
