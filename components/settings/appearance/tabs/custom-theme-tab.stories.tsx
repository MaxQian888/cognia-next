import type { Meta, StoryObj } from "@storybook/nextjs"

import { CustomThemeTab } from "./custom-theme-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Appearance → Custom theme tab: the role-grouped token editor + live preview
// + saved-themes rail. Reads the settings store (customThemes, active id).
const meta = {
  title: "Settings/Appearance/Tabs/CustomThemeTab",
  component: CustomThemeTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof CustomThemeTab>

export default meta
type Story = StoryObj<typeof meta>

// No saved themes yet → editor seeded from the default fallback palette.
export const Default: Story = {}
