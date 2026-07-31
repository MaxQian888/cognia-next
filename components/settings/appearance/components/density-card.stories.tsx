import type { Meta, StoryObj } from "@storybook/nextjs"

import { DensityCard } from "./density-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// UI density controls. Reads `settings.density` (merged over DEFAULT_DENSITY)
// and writes patches through the settings store.
const meta = {
  title: "Settings/Appearance/DensityCard",
  component: DensityCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof DensityCard>

export default meta
type Story = StoryObj<typeof meta>

// Default density.
export const Default: Story = {}
