import type { Meta, StoryObj } from "@storybook/nextjs"

import { BackupRestoreTab } from "./backup-restore-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Data → Backup & restore tab: export/import a full data archive, WebDAV sync
// card, and backup history. Reads the settings store; file IO is Tauri-backed.
const meta = {
  title: "Settings/Data/Tabs/BackupRestoreTab",
  component: BackupRestoreTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof BackupRestoreTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
