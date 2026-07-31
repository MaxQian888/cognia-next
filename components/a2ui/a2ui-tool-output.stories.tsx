import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIToolOutput } from "./a2ui-tool-output"
import { resetStore } from "@/lib/storybook/seed-stores"
import { makeSimplifiedSpec } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

// A2UIToolOutput parses an agent tool's `output`, ingests it into the A2UI store
// on mount, then renders the resulting surface. Feeding the simplified A2UI spec
// exercises that full parse → render path.
const meta = {
  title: "A2UI/ToolOutput",
  component: A2UIToolOutput,
  parameters: { layout: "centered" },
  args: {
    toolId: "demo",
    toolName: "render_widget",
    output: makeSimplifiedSpec("tool-demo"),
    onAction: fn(),
    onDataChange: fn(),
  },
  beforeEach: () => {
    resetStore(useA2UIStore)
  },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof A2UIToolOutput>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const NoA2UIContent: Story = {
  args: { output: "Plain tool output with no A2UI payload." },
}
