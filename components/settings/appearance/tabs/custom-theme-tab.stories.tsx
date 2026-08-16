import type { Meta, StoryObj } from "@storybook/nextjs"

import { CustomThemeTab } from "./custom-theme-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Appearance → Custom theme tab: the role-grouped token editor + live preview
// + saved-themes rail. Reads the settings store (customThemes, active id).
// Multi-column layout here sizes off `@container/appearance-pane`, which
// `appearance-section.tsx` owns in the real app — the decorator stands in for
// it so this story previews the same layout the settings pane shows.
const meta = {
  title: "Settings/Appearance/Tabs/CustomThemeTab",
  component: CustomThemeTab,
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
} satisfies Meta<typeof CustomThemeTab>

export default meta
type Story = StoryObj<typeof meta>

// No saved themes yet → editor seeded from the default fallback palette.
export const Default: Story = {}
