import type { Meta, StoryObj } from "@storybook/nextjs"

import { WallpaperTab } from "./wallpaper-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Appearance → Wallpaper tab: gallery + uploader + gradient builder + the
// background opacity/contrast verdict. Reads flattened store fields
// (background, wallpapers), defaulted when settings is empty.
const meta = {
  title: "Settings/Appearance/Tabs/WallpaperTab",
  component: WallpaperTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof WallpaperTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
