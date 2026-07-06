import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillDeleteDialog } from "./skill-delete-dialog"

// Pure confirmation dialog — controlled by `open`, with cancel/confirm callbacks.
const meta = {
  title: "Skills/SkillDeleteDialog",
  component: SkillDeleteDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    skillName: "Release Notes Writer",
    onCancel: fn(),
    onConfirm: fn(),
  },
} satisfies Meta<typeof SkillDeleteDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const LongName: Story = {
  args: { skillName: "Quarterly Board Deck Generator With Financial Appendices" },
}

export const Closed: Story = {
  args: { open: false },
}
