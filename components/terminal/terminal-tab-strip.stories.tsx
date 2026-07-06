import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TerminalTabStrip } from "./terminal-tab-strip"
import { Button } from "@/components/ui/button"
import { makeTerminalSession } from "@/lib/storybook/fixtures/terminal"

// Horizontal tab strip shared by the desktop dock + the mobile screen.
// Presentational — owns no state; a `trailing` slot holds shell affordances.
const tabs = [
  makeTerminalSession({ title: "pwsh", status: "idle" }),
  makeTerminalSession({ title: "pnpm dev", status: "running" }),
  makeTerminalSession({ title: "build", status: "exited", exitCode: 0 }),
  makeTerminalSession({ title: "tests", status: "exited", exitCode: 1 }),
]

const meta = {
  title: "Terminal/TabStrip",
  component: TerminalTabStrip,
  parameters: { layout: "fullscreen" },
  args: {
    tabs,
    activeId: tabs[1].id,
    onSelect: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof TerminalTabStrip>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Single: Story = {
  args: { tabs: [tabs[0]], activeId: tabs[0].id },
}

export const WithTrailingControl: Story = {
  args: {
    trailing: (
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
        + New
      </Button>
    ),
  },
}
