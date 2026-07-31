import type { Meta, StoryObj } from "@storybook/nextjs"

import { WebDavSyncCard } from "./webdav-sync-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// WebDAV backup/sync configuration card (endpoint + credentials + sync now).
// Reads the settings store; the network sync action is Tauri-backed.
const meta = {
  title: "Settings/Data/WebDavSyncCard",
  component: WebDavSyncCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof WebDavSyncCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
