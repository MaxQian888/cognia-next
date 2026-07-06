import type { Meta, StoryObj } from "@storybook/nextjs"

import { SettingsActionsMenu } from "./settings-actions-menu"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Settings header overflow menu: review changed settings, export/import a
// settings profile, or reset all. Reads the settings store; the trigger is an
// icon button — open it in the preview to see the menu items.
const meta = {
  title: "Settings/Actions/SettingsActionsMenu",
  component: SettingsActionsMenu,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof SettingsActionsMenu>

export default meta
type Story = StoryObj<typeof meta>

// Menu trigger; click to reveal review / export / import / reset items.
export const Default: Story = {}
