import type { Meta, StoryObj } from "@storybook/nextjs"

import { DataSection } from "./data-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Data management settings shell (overview / backup-restore / domain transfer /
// maintenance tabs). URL-driven active tab (App Router mocks default it to
// overview). Reads the settings store.
const meta = {
  title: "Settings/Data/DataSection",
  component: DataSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof DataSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
