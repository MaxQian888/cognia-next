import type { Meta, StoryObj } from "@storybook/nextjs"

import { CanvasSimulationRichOutput } from "./canvas-simulation-rich-output"

// Animated 2D canvas wave simulation. `config` tunes amplitude/frequency.
const meta = {
  title: "A2UI/RichOutput/CanvasSimulation",
  component: CanvasSimulationRichOutput,
  parameters: { layout: "centered" },
  args: { config: { amplitude: 24, frequency: 2 } },
  decorators: [
    (Story) => (
      <div className="h-[300px] w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CanvasSimulationRichOutput>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const HighFrequency: Story = {
  args: { config: { amplitude: 40, frequency: 6 } },
}
