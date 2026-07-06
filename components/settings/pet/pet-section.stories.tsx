import type { Meta, StoryObj } from "@storybook/nextjs"

import { PetSection } from "./pet-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"

// Store-reading: PetSection reads `settings.petSettings` (falling back to
// DEFAULT_PET_SETTINGS) and renders the appearance/interaction/sound/care
// control groups. The desktop-overlay group is Tauri-only and stays hidden in
// the Storybook browser. Reset the settings store between stories.
function seed(pet: PetSettings) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAppSettings({ petSettings: pet }) })
  }
}

const meta = {
  title: "Settings/Pet/PetSection",
  component: PetSection,
  parameters: { layout: "padded" },
  beforeEach: seed(DEFAULT_PET_SETTINGS),
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetSection>

export default meta
type Story = StoryObj<typeof meta>

// Pet enabled with default preferences.
export const Default: Story = {}

// Master switch off — the control groups still render but the subsystem is idle.
export const Disabled: Story = {
  beforeEach: seed({ ...DEFAULT_PET_SETTINGS, enabled: false }),
}

// A customized pet — larger widget, top-left anchor, muted bubbles.
export const Customized: Story = {
  beforeEach: seed({
    ...DEFAULT_PET_SETTINGS,
    size: 128,
    anchor: "top-left",
    mutedBubbles: true,
    motion: "reduced",
  }),
}
