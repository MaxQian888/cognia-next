import type { Meta, StoryObj } from "@storybook/nextjs"

import { AdvancedTab } from "./advanced-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Appearance → Advanced tab: custom CSS editor (+ scope), Monaco link card,
// and other power-user toggles. Reads flattened store fields (customCss,
// customCssEnabled, customCssScope) which default safely when settings is empty.
const meta = {
  title: "Settings/Appearance/Tabs/AdvancedTab",
  component: AdvancedTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof AdvancedTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
