import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { VariablePicker } from "./variable-picker"

// Popover that browses upstream node outputs as a searchable tree and inserts a
// `{{ $node['id'].path }}` reference. Pure props — give it a small graph where
// `trigger → summarize → reply` and outputs for the upstream nodes. Open the
// popover (it is closed by default) to see the tree.
const nodes = [
  { id: "trigger", kind: "trigger.manual", label: "When triggered" },
  { id: "summarize", kind: "action.agent.turn", label: "Summarize thread" },
  { id: "reply", kind: "action.character.send", label: "Send reply" },
]

const edges = [
  { source: "trigger", target: "summarize" },
  { source: "summarize", target: "reply" },
]

const outputs = {
  trigger: { payload: { channel: "general", userId: "u_123" } },
  summarize: { text: "Three updates since yesterday.", tokens: 412, model: "claude-sonnet-4" },
}

const meta = {
  title: "Workflow/Editor/Inspector/Forms/Shared/VariablePicker",
  component: VariablePicker,
  parameters: { layout: "centered" },
  args: {
    currentNodeId: "reply",
    nodes,
    edges,
    outputs,
    onInsert: fn(),
  },
} satisfies Meta<typeof VariablePicker>

export default meta
type Story = StoryObj<typeof meta>

// From "reply", both upstream nodes (trigger + summarize) are in scope.
export const Default: Story = {}

// From the first action, only the trigger is upstream.
export const SingleUpstream: Story = {
  args: { currentNodeId: "summarize" },
}

// Disabled trigger button.
export const Disabled: Story = {
  args: { disabled: true },
}
