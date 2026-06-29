import type { Meta, StoryObj } from "@storybook/nextjs"

import { CredentialsTab } from "./credentials-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// GitHub Delivery → Credentials tab: PAT / GitHub App credential entry +
// connection status. Reads the settings store; secret storage is Tauri-backed.
const meta = {
  title: "Settings/GithubDelivery/Tabs/CredentialsTab",
  component: CredentialsTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof CredentialsTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
