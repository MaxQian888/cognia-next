import type { Meta, StoryObj } from "@storybook/nextjs"

import { D3ForceGraphRichOutput } from "./d3-force-graph-rich-output"

// D3 force-directed graph (SVG). Keep the graph tiny so the simulation settles
// quickly inside the story.
const meta = {
  title: "A2UI/RichOutput/D3ForceGraph",
  component: D3ForceGraphRichOutput,
  parameters: { layout: "centered" },
  args: {
    nodes: [
      { id: "a", label: "Input" },
      { id: "b", label: "Model" },
      { id: "c", label: "Output" },
    ],
    edges: [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ],
  },
  decorators: [
    (Story) => (
      <div className="h-[340px] w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof D3ForceGraphRichOutput>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
