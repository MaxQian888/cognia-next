import type { Meta, StoryObj } from "@storybook/nextjs"

import { PoliciesTab } from "./policies-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// GitHub Delivery → Policies tab: the global default policy editor (PolicyForm)
// plus per-repo overrides. Reads `settings.githubDelivery` from the store.
const meta = {
  title: "Settings/GithubDelivery/Tabs/PoliciesTab",
  component: PoliciesTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof PoliciesTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
