import type { Meta, StoryObj } from "@storybook/nextjs"

import { BuiltInSkillsSection } from "./index"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Tabbed shell for the built-in skills (ADR-0026): the surface-skills master
// toggle (settings store) plus the Lark family tab (loads the shared built-in
// skill registry on mount).
const meta = {
  title: "Settings/BuiltInSkills/Section",
  component: BuiltInSkillsSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof BuiltInSkillsSection>

export default meta
type Story = StoryObj<typeof meta>

// Surface skills on (default), Lark tab populated from the registry.
export const Default: Story = {}

// Surface auto-activation explicitly disabled.
export const SurfaceSkillsDisabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      loaded: true,
      settings: makeAppSettings({ surfaceSkillsEnabled: false }),
    })
  },
}
