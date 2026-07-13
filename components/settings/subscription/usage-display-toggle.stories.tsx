import type { Meta, StoryObj } from "@storybook/nextjs"

import { UsageDisplayToggle } from "./usage-display-toggle"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"

// `UsageDisplayToggle` reflects the global `AppSettings.usageDisplayMode.mode`
// via `useUsageDisplayMode` (a `useSettingsStore` selector). Reset the store
// between stories and seed the desired mode so the correct segment is pressed.
function seedMode(mode: "simplified" | "standard" | "detailed") {
  seedStore(useSettingsStore, {
    settings: { usageDisplayMode: { mode } } as AppSettings,
  })
}

const meta = {
  title: "Settings/Subscription/UsageDisplayToggle",
  component: UsageDisplayToggle,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
} satisfies Meta<typeof UsageDisplayToggle>

export default meta
type Story = StoryObj<typeof meta>

// No stored preference → resolves to the default "standard" mode.
export const Default: Story = {}

export const Simplified: Story = {
  beforeEach: () => seedMode("simplified"),
}

export const Standard: Story = {
  beforeEach: () => seedMode("standard"),
}

export const Detailed: Story = {
  beforeEach: () => seedMode("detailed"),
}
