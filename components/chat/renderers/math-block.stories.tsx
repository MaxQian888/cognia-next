import type { Meta, StoryObj } from "@storybook/nextjs"

import { MathBlock } from "./math-block"

const meta = {
  title: "Chat/Renderers/MathBlock",
  component: MathBlock,
  parameters: { layout: "padded" },
  args: { content: "\\int_{a}^{b} f(x)\\,dx = F(b) - F(a)" },
} satisfies Meta<typeof MathBlock>

export default meta
type Story = StoryObj<typeof meta>

// Centered display equation with the hover toolbar (source / copy / fullscreen).
export const Default: Story = {}

export const QuadraticFormula: Story = {
  args: { content: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}" },
}

export const LeftAligned: Story = {
  args: { content: "e^{i\\pi} + 1 = 0", alignment: "left" },
}

export const Scaled: Story = {
  args: { content: "\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}", scale: 1.6 },
}

// Invalid LaTeX falls through to the destructive error card with the raw source.
export const RenderError: Story = {
  args: { content: "\\frac{1}{\\unknowncommand{" },
}
