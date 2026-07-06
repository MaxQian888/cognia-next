import type { Meta, StoryObj } from "@storybook/nextjs"

import { TypographyTab } from "./typography-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Appearance → Typography tab: interface/serif/mono font family pickers and
// fine-tuning (line height, letter spacing). Reads the settings store.
const meta = {
  title: "Settings/Appearance/Tabs/TypographyTab",
  component: TypographyTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof TypographyTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
