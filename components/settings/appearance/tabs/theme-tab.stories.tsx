import type { Meta, StoryObj } from "@storybook/nextjs"

import { ThemeTab } from "./theme-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Appearance → Theme tab: light/dark mode, accent + radius presets, and the
// active-theme picker. Reads the settings store; seeded with a loaded snapshot.
const meta = {
  title: "Settings/Appearance/Tabs/ThemeTab",
  component: ThemeTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof ThemeTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
