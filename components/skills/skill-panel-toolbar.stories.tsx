import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillPanelToolbar } from "./skill-panel-toolbar"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"
import { useSettingsStore } from "@/stores/settings"

// Propless toolbar — reads the skills + settings stores and several skill
// hooks. File-system actions resolve through the (web) file bridge on click.
const meta = {
  title: "Skills/SkillPanelToolbar",
  component: SkillPanelToolbar,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useSkillsStore)
    resetStore(useSettingsStore)
  },
} satisfies Meta<typeof SkillPanelToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
