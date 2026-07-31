import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactRenderer } from "./artifact-renderers"
import type { ChartDataPoint } from "@/types"
import { makeArtifact } from "@/lib/storybook/fixtures/artifacts"

const chartData: ChartDataPoint[] = [
  { name: "Mon", value: 12 },
  { name: "Tue", value: 19 },
  { name: "Wed", value: 7 },
  { name: "Thu", value: 22 },
  { name: "Fri", value: 16 },
]

// Generic renderer that routes to the right per-type renderer (code / document
// / mermaid / math / chart). Each story exercises one transport.
const meta = {
  title: "Artifacts/ArtifactRenderer",
  component: ArtifactRenderer,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[640px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactRenderer>

export default meta
type Story = StoryObj<typeof meta>

export const Code: Story = {
  args: {
    type: "code",
    content: "export const greet = (n: string) => `Hello, ${n}!`\n",
    artifact: makeArtifact(),
  },
}

export const Document: Story = {
  args: {
    type: "document",
    content: "# Design notes\n\n- First point\n- Second point\n\n**Bold** and `inline code`.",
  },
}

export const Mermaid: Story = {
  args: { type: "mermaid", content: "graph TD\n  A[Start] --> B[Done]" },
}

export const Math: Story = {
  args: { type: "math", content: "E = mc^2" },
}

export const Chart: Story = {
  args: { type: "chart", content: "", chartType: "bar", chartData },
}
