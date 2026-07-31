import type { Meta, StoryObj } from "@storybook/nextjs"

import { DataOverviewTab } from "./data-overview-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Data → Overview tab: storage usage breakdown + backup status summary. Reads
// the settings store and Dexie tables; in the browser it renders against the
// fresh in-browser IndexedDB.
const meta = {
  title: "Settings/Data/Tabs/DataOverviewTab",
  component: DataOverviewTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof DataOverviewTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
