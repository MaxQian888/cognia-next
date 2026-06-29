import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { NodeFloatingToolbar } from "./node-floating-toolbar"

// Flowith-style floating mini toolbar shown above a node: Run · Copy ·
// Configure · Delete · More. Pure props. The Run button hides for triggers /
// annotations (non-runnable categories).
const meta = {
  title: "Workflow/Editor/Nodes/NodeFloatingToolbar",
  component: NodeFloatingToolbar,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="p-12">{Story()}</div>],
  args: {
    nodeId: "n_1",
    kind: "action.agent.turn",
    alwaysVisible: true,
    motionEnabled: true,
    onRun: fn(),
    onCopy: fn(),
    onConfigure: fn(),
    onDelete: fn(),
    onMore: fn(),
  },
} satisfies Meta<typeof NodeFloatingToolbar>

export default meta
type Story = StoryObj<typeof meta>

// An action node — all five buttons including Run.
export const ActionNode: Story = {}

// A trigger node — Run is hidden (triggers aren't directly runnable).
export const TriggerNode: Story = {
  args: { kind: "trigger.manual" },
}

// Motion disabled (reduced-motion / low perf tier) — CSS-only reveal.
export const NoMotion: Story = {
  args: { motionEnabled: false },
}
