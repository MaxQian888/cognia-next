import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TemplateSelector } from "./template-selector"

const meta = {
  title: "Agent/Mode/CustomModeEditor/TemplateSelector",
  component: TemplateSelector,
  args: { onSelect: fn() },
} satisfies Meta<typeof TemplateSelector>

export default meta
type Story = StoryObj<typeof meta>

// Grid of the built-in MODE_TEMPLATES; click a card to fire onSelect.
export const Default: Story = {}
