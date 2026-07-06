import type { Meta, StoryObj } from "@storybook/nextjs"

import { GithubDeliverySection } from "./github-delivery-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// GitHub Delivery settings shell (credentials / repos / policies / usage /
// audit tabs). Reads the settings store and Dexie tables; in the browser the
// Dexie-backed tabs render empty and Tauri-gated affordances are disabled.
const meta = {
  title: "Settings/GithubDelivery/GithubDeliverySection",
  component: GithubDeliverySection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof GithubDeliverySection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
