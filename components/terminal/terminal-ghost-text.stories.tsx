import type { Meta, StoryObj } from "@storybook/nextjs"

import { TerminalGhostText } from "./terminal-ghost-text"

// Inline "ghost text" overlay for the terminal's Copilot-style autocomplete.
// Purely presentational; positioned at the cursor pixel by the parent. Renders
// nothing without a suffix. The decorator gives it a positioned container.
const meta = {
  title: "Terminal/GhostText",
  component: TerminalGhostText,
  parameters: { layout: "padded" },
  args: {
    ghost: " status --short",
    left: 16,
    top: 16,
    fontFamily: "monospace",
    fontSize: 14,
    source: "history",
    acceptHint: "Tab",
  },
  decorators: [
    (Story) => (
      <div className="relative h-24 w-[420px] rounded bg-[#1f2430] p-2 font-mono text-sm text-emerald-300">
        <span style={{ position: "absolute", left: 8, top: 16 }}>$ git</span>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalGhostText>

export default meta
type Story = StoryObj<typeof meta>

export const FromHistory: Story = {}

export const FromAi: Story = {
  args: { ghost: " --force-with-lease origin main", source: "ai", acceptHint: "→" },
}

export const NoAcceptHint: Story = {
  args: { acceptHint: undefined },
}

export const Hidden: Story = {
  args: { ghost: "" },
}
