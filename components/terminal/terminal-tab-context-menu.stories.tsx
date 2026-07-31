import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TerminalTabContextMenu } from "./terminal-tab-context-menu"
import { makeTerminalSession } from "@/lib/storybook/fixtures/terminal"

// Right-click menu for a terminal tab. Trigger-wrapper around shadcn ContextMenu.
// Right-click the wrapped tab body to open it. The edit group (copy/paste/…) only
// renders when those callbacks are supplied; locate-in-chat needs an agentSpawner.
const Target = () => (
  <div className="flex w-40 select-none items-center justify-center rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground">
    Right-click this tab
  </div>
)

const meta = {
  title: "Terminal/TabContextMenu",
  component: TerminalTabContextMenu,
  parameters: { layout: "centered" },
  args: {
    row: makeTerminalSession(),
    children: <Target />,
    onRename: fn(),
    onRestart: fn(),
    onClose: fn(),
    onCloseOthers: fn(),
    onToggleAgentTrust: fn(),
  },
} satisfies Meta<typeof TerminalTabContextMenu>

export default meta
type Story = StoryObj<typeof meta>

export const TabActionsOnly: Story = {}

export const WithEditGroup: Story = {
  args: {
    onCopy: fn(),
    onPaste: fn(),
    onSelectAll: fn(),
    onClear: fn(),
    onFind: fn(),
  },
}

export const AgentSpawned: Story = {
  args: {
    row: makeTerminalSession({ agentSpawner: "chat_42", agentTrusted: true }),
    onLocateInChat: fn(),
  },
}
