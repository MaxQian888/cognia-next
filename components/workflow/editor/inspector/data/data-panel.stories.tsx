import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DataPanel } from "./data-panel"

// The body of an NDV Input/Output tab for one value: Table/JSON/Schema toggle,
// array-item navigator, empty state with a "Run this step" CTA, and (Output
// tab) pin/unpin controls. Pure props.
const meta = {
  title: "Workflow/Editor/Inspector/Data/DataPanel",
  component: DataPanel,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="w-[420px]">{Story()}</div>],
  args: { sourceNodeId: "summarize", value: undefined, source: "run" },
} satisfies Meta<typeof DataPanel>

export default meta
type Story = StoryObj<typeof meta>

// Resolved output from a run — object value, view toggle visible.
export const RunOutput: Story = {
  args: {
    value: { text: "Three updates since yesterday.", tokens: 412 },
    source: "run",
  },
}

// Array output enables the item navigator.
export const ArrayOutput: Story = {
  args: {
    value: [
      { name: "Ada", role: "researcher" },
      { name: "Grace", role: "reviewer" },
    ],
    source: "run",
  },
}

// Pinned value — pin badge + unpin/edit controls.
export const Pinned: Story = {
  args: {
    value: { completion: "fixture output" },
    source: "pin",
    pin: { pinned: true, onPin: fn(), onUnpin: fn() },
  },
}

// No data yet — empty state with the "Run this step" CTA.
export const Empty: Story = {
  args: { value: undefined, source: "none", onRunStep: fn() },
}
