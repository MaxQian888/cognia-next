import type { Meta, StoryObj } from "@storybook/nextjs"

import { UsageDisplayCard } from "./usage-display-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Usage/consumption statistics display-mode select. Reads/writes
// `settings.usageDisplayMode` via `useUsageDisplayMode`.
const meta = {
  title: "Settings/Appearance/UsageDisplayCard",
  component: UsageDisplayCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof UsageDisplayCard>

export default meta
type Story = StoryObj<typeof meta>

// Default mode.
export const Default: Story = {}

// Simplified mode pre-selected.
export const Simplified: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      loaded: true,
      settings: makeAppSettings({ usageDisplayMode: { mode: "simplified" } }),
    })
  },
}
