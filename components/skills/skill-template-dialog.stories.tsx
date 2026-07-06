import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillTemplateDialog } from "./skill-template-dialog"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"

// Controlled by `open`/`onOpenChange`. Picking a card calls the store's
// `openCreate` seed action, so reset the store between renders.
const meta = {
  title: "Skills/SkillTemplateDialog",
  component: SkillTemplateDialog,
  parameters: { layout: "centered" },
  args: { open: true, onOpenChange: fn() },
  beforeEach: () => {
    resetStore(useSkillsStore)
  },
} satisfies Meta<typeof SkillTemplateDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Gallery: Story = {}

export const Closed: Story = {
  args: { open: false },
}
