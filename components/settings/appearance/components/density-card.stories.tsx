import type { Meta, StoryObj } from "@storybook/nextjs"

import { DensityCard } from "./density-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// UI density controls. Reads `settings.density` (merged over DEFAULT_DENSITY)
// and writes patches through the settings store.
// Multi-column layout here sizes off `@container/appearance-pane`, which
// `appearance-section.tsx` owns in the real app — the decorator stands in for
// it so this story previews the same layout the settings pane shows.
const meta = {
  title: "Settings/Appearance/DensityCard",
  component: DensityCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="@container/appearance-pane">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof DensityCard>

export default meta
type Story = StoryObj<typeof meta>

// Default density.
export const Default: Story = {}
