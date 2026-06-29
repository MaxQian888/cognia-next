import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ToolSelector } from "./tool-selector"

const meta = {
  title: "Agent/Mode/CustomModeEditor/ToolSelector",
  component: ToolSelector,
  args: { value: [], onChange: fn() },
} satisfies Meta<typeof ToolSelector>

export default meta
type Story = StoryObj<typeof meta>

// No tools selected; expand a category to toggle individual tools.
export const Empty: Story = {}

export const WithSelection: Story = {
  args: { value: ["read_file", "write_file", "bash"] },
}
