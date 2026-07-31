import type { Meta, StoryObj } from "@storybook/nextjs"

import { ThemePackTab } from "./theme-pack-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Appearance → Theme pack tab: one-click bundles that set wallpaper + theme
// together. Reads the settings store and drives setActiveWallpaper /
// setActiveCustomTheme on apply.
const meta = {
  title: "Settings/Appearance/Tabs/ThemePackTab",
  component: ThemePackTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof ThemePackTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
