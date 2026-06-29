import type { Meta, StoryObj } from "@storybook/nextjs"

import { MaintenanceTab } from "./maintenance-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Data → Maintenance tab: cache cleanup, vacuum/compaction, and related upkeep
// toggles. Reads + writes the settings store.
const meta = {
  title: "Settings/Data/Tabs/MaintenanceTab",
  component: MaintenanceTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof MaintenanceTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
