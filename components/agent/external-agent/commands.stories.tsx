import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ExternalAgentCommands } from "./commands"
import type { AcpAvailableCommand } from "@/types/agent/external-agent"

const COMMANDS: AcpAvailableCommand[] = [
  { name: "compact", description: "Compact the conversation to reclaim context window" },
  { name: "clear", description: "Clear the current session transcript" },
  {
    name: "review",
    description: "Review a pull request and leave inline comments",
    input: { hint: "<pr-number>" },
  },
  {
    name: "test",
    description: "Run the test suite, optionally for a path",
    input: { hint: "[path]" },
  },
]

const meta = {
  title: "Agent/ExternalAgent/Commands",
  component: ExternalAgentCommands,
  args: {
    commands: COMMANDS,
    onExecute: fn(),
  },
} satisfies Meta<typeof ExternalAgentCommands>

export default meta
type Story = StoryObj<typeof meta>

// Trigger button only; click it in the preview to open the command popover.
export const Default: Story = {}

export const SingleCommand: Story = {
  args: { commands: [COMMANDS[0]] },
}

export const Executing: Story = {
  args: { isExecuting: true },
}

// No commands → the component renders nothing.
export const Empty: Story = {
  args: { commands: [] },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <ExternalAgentCommands {...args} />
    </div>
  ),
}
