import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ShortcutsCheatsheet } from "./shortcuts-cheatsheet"

const meta = {
  title: "Workflow/ShortcutsCheatsheet",
  component: ShortcutsCheatsheet,
  parameters: { layout: "centered" },
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof ShortcutsCheatsheet>

export default meta
type Story = StoryObj<typeof meta>

// The keyboard-shortcuts dialog, opened.
export const Open: Story = {}
