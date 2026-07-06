import type { Meta, StoryObj } from "@storybook/nextjs"

import { ComponentsTab } from "./components-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Appearance → Components tab: per-component UI style toggles. Reads the
// settings store.
const meta = {
  title: "Settings/Appearance/Tabs/ComponentsTab",
  component: ComponentsTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof ComponentsTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
