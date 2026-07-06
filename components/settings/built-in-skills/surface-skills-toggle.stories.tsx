import type { Meta, StoryObj } from "@storybook/nextjs"

import { SurfaceSkillsToggle } from "./surface-skills-toggle"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Single card governing whether surface-specific guidance skills are auto-
// injected. Reads `settings.surfaceSkillsEnabled` (default ON: only an explicit
// `false` disables).
const meta = {
  title: "Settings/BuiltInSkills/SurfaceSkillsToggle",
  component: SurfaceSkillsToggle,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof SurfaceSkillsToggle>

export default meta
type Story = StoryObj<typeof meta>

// Absent flag → toggle defaults ON.
export const Enabled: Story = {}

// Explicit `false` → toggle OFF.
export const Disabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      loaded: true,
      settings: makeAppSettings({ surfaceSkillsEnabled: false }),
    })
  },
}
