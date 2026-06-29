import type { Meta, StoryObj } from "@storybook/nextjs"

import { A11yTab } from "./a11y-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Appearance → Accessibility tab: reduced motion, high-contrast, and related
// a11y toggles. Reads the settings store.
const meta = {
  title: "Settings/Appearance/Tabs/A11yTab",
  component: A11yTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof A11yTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
