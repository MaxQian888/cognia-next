import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { IconSelector } from "./icon-selector"

const meta = {
  title: "Agent/Mode/CustomModeEditor/IconSelector",
  component: IconSelector,
  args: { value: "Bot", onChange: fn() },
} satisfies Meta<typeof IconSelector>

export default meta
type Story = StoryObj<typeof meta>

// Collapsed trigger; expand it in the preview to browse the icon grid.
export const Default: Story = {}

export const DifferentIcon: Story = {
  args: { value: "Sparkles" },
}
