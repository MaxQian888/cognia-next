import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ExternalAgentConfigOptions } from "./config-options"
import type { AcpConfigOption } from "@/types/agent/external-agent"

const OPTIONS: AcpConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default", description: "Normal permission flow" },
      { value: "acceptEdits", name: "Accept edits", description: "Auto-accept file edits" },
      { value: "plan", name: "Plan", description: "Planning only, no execution" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "sonnet",
    options: [
      { value: "sonnet", name: "Claude Sonnet" },
      { value: "opus", name: "Claude Opus", description: "Most capable, slower" },
      { value: "haiku", name: "Claude Haiku", description: "Fastest" },
    ],
  },
  {
    id: "thought_level",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "off", name: "Off" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
]

const meta = {
  title: "Agent/ExternalAgent/ConfigOptions",
  component: ExternalAgentConfigOptions,
  args: {
    configOptions: OPTIONS,
    // Echo the unchanged set back so the selector keeps its value.
    onSetConfigOption: fn(async () => OPTIONS),
  },
} satisfies Meta<typeof ExternalAgentConfigOptions>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Compact: Story = {
  args: { compact: true },
}

export const Disabled: Story = {
  args: { disabled: true },
}

// Empty option list → the component renders nothing.
export const Empty: Story = {
  args: { configOptions: [] },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <ExternalAgentConfigOptions {...args} />
    </div>
  ),
}
