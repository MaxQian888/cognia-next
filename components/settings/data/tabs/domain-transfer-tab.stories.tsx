import type { Meta, StoryObj } from "@storybook/nextjs"

import { DomainTransferTab } from "./domain-transfer-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Data → Domain transfer tab: per-domain selective export/import (move a
// subset of data between installs). Reads the settings store; some IO is
// Tauri-gated.
const meta = {
  title: "Settings/Data/Tabs/DomainTransferTab",
  component: DomainTransferTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof DomainTransferTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
