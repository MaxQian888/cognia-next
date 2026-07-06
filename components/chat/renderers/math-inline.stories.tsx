import type { Meta, StoryObj } from "@storybook/nextjs"

import { MathInline } from "./math-inline"

const meta = {
  title: "Chat/Renderers/MathInline",
  component: MathInline,
  parameters: { layout: "padded" },
  args: { content: "a^2 + b^2 = c^2" },
} satisfies Meta<typeof MathInline>

export default meta
type Story = StoryObj<typeof meta>

// A single inline expression — copy glyph appears on hover.
export const Default: Story = {}

// Embedded in a sentence, the way the markdown renderer emits it.
export const InProse: Story = {
  render: () => (
    <p className="text-sm leading-relaxed">
      The Pythagorean theorem states that <MathInline content="a^2 + b^2 = c^2" /> for any right
      triangle, and Euler&apos;s identity <MathInline content="e^{i\\pi} + 1 = 0" /> ties five
      constants together.
    </p>
  ),
}

export const Scaled: Story = {
  args: { content: "\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}", scale: 1.4 },
}

// Invalid LaTeX renders the raw text with a destructive tint + tooltip.
export const InvalidExpression: Story = {
  args: { content: "\\frac{1}{" },
}
