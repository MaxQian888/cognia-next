import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TerminalTab } from "./terminal-tab"
import { makeTerminalSession } from "@/lib/storybook/fixtures/terminal"

// One tab in the terminal dock header: title + a status dot (idle / running /
// exited-ok / exited-fail) + a hover close button.
const meta = {
  title: "Terminal/Tab",
  component: TerminalTab,
  parameters: { layout: "padded" },
  args: {
    row: makeTerminalSession(),
    active: false,
    onSelect: fn(),
    onClose: fn(),
  },
  decorators: [
    (Story) => (
      <div className="flex gap-1 border-b bg-muted/30 p-1.5">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalTab>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {}

export const Active: Story = { args: { active: true } }

export const Running: Story = {
  args: { row: makeTerminalSession({ status: "running", title: "pnpm dev" }) },
}

export const ExitedOk: Story = {
  args: { row: makeTerminalSession({ status: "exited", exitCode: 0, title: "build" }) },
}

export const ExitedFail: Story = {
  args: { row: makeTerminalSession({ status: "exited", exitCode: 1, title: "build" }) },
}

export const AgentTrusted: Story = {
  args: {
    active: true,
    row: makeTerminalSession({ agentTrusted: true, agentSpawner: "chat_1", title: "agent shell" }),
  },
}

export const CustomTitle: Story = {
  args: { row: makeTerminalSession({ customTitle: "deploy prod", title: "bash" }) },
}
