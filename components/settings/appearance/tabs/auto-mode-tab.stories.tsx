import type { Meta, StoryObj } from "@storybook/nextjs"

import { AutoModeTab } from "./auto-mode-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Appearance → Auto mode tab: automatic light/dark switching schedule. Reads
// the flattened `autoMode` store field (defaulted when settings is empty).
// Multi-column layout here sizes off `@container/appearance-pane`, which
// `appearance-section.tsx` owns in the real app — the decorator stands in for
// it so this story previews the same layout the settings pane shows.
const meta = {
  title: "Settings/Appearance/Tabs/AutoModeTab",
  component: AutoModeTab,
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
} satisfies Meta<typeof AutoModeTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
