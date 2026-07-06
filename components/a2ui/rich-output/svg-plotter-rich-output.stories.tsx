import type { Meta, StoryObj } from "@storybook/nextjs"

import { SvgPlotterRichOutput } from "./svg-plotter-rich-output"

const sine = Array.from({ length: 24 }, (_, i) => ({
  x: i,
  y: Math.sin(i / 3) * 10 + 12,
}))

// Pure-SVG line plot — lightweight, theme-token coloured.
const meta = {
  title: "A2UI/RichOutput/SvgPlotter",
  component: SvgPlotterRichOutput,
  parameters: { layout: "centered" },
  args: { points: sine },
  decorators: [
    (Story) => (
      <div className="w-[520px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SvgPlotterRichOutput>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const FewPoints: Story = {
  args: {
    points: [
      { x: 0, y: 2 },
      { x: 1, y: 8 },
      { x: 2, y: 4 },
      { x: 3, y: 10 },
    ],
  },
}
