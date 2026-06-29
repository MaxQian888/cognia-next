import type { Meta, StoryObj } from "@storybook/nextjs"

import { AppearanceSection } from "./appearance-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Tabbed shell for the Appearance section (theme / auto / theme pack /
// wallpaper / custom / import / typography / components / a11y / advanced).
// The active tab is URL-driven; App Router mocks default it to "theme". Reads
// the settings store, so it is seeded with a loaded snapshot.
const meta = {
  title: "Settings/Appearance/AppearanceSection",
  component: AppearanceSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof AppearanceSection>

export default meta
type Story = StoryObj<typeof meta>

// Default → Theme tab active.
export const Default: Story = {}
