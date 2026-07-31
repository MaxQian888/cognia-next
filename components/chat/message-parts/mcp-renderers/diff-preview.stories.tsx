import type { Meta, StoryObj } from "@storybook/nextjs"

import { DiffPreview } from "./diff-preview"

const meta = {
  title: "Chat/MCP/DiffPreview",
  component: DiffPreview,
  parameters: { layout: "padded" },
} satisfies Meta<typeof DiffPreview>

export default meta
type Story = StoryObj<typeof meta>

// Removed lines (red) followed by added lines (green).
export const Replace: Story = {
  args: {
    oldText: "return clsx(inputs)",
    newText: "return twMerge(clsx(inputs))",
  },
}

// Pure addition — only the green added block renders.
export const AdditionOnly: Story = {
  args: {
    oldText: "",
    newText: "export const VERSION = '2.0.0'\nexport const BUILD = 'stable'",
  },
}

// Pure deletion — only the red removed block renders.
export const DeletionOnly: Story = {
  args: {
    oldText: "// deprecated helper\nfunction legacy() {}",
    newText: "",
  },
}
