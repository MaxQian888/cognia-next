import type { Meta, StoryObj } from "@storybook/nextjs"

import { SectionResetButton } from "./section-reset-button"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Per-section "reset to defaults" affordance. Renders a button (opens a confirm
// AlertDialog) only for sections with a mapped key-set; for unmapped sections
// it renders nothing so callers can drop it in unconditionally.
const meta = {
  title: "Settings/Common/SectionResetButton",
  component: SectionResetButton,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof SectionResetButton>

export default meta
type Story = StoryObj<typeof meta>

// "tools" is a mapped section → the reset button renders.
export const Tools: Story = {
  args: { sectionId: "tools" },
}

// "conversation" is also mapped → reset button renders.
export const Conversation: Story = {
  args: { sectionId: "conversation" },
}
