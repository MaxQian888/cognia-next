import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TerminalEmptyState } from "./terminal-empty-state"

// Empty-state body for the terminal dock across the three shells: desktop (with a
// "+ New terminal" CTA), mobile (LAN bridge placeholder), and plain browser.
const meta = {
  title: "Terminal/EmptyState",
  component: TerminalEmptyState,
  parameters: { layout: "fullscreen" },
  args: { variant: "desktop", onNew: fn() },
  decorators: [
    (Story) => (
      <div className="h-[320px] w-full border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalEmptyState>

export default meta
type Story = StoryObj<typeof meta>

export const Desktop: Story = {}

export const Mobile: Story = { args: { variant: "mobile" } }

export const Unsupported: Story = { args: { variant: "unsupported" } }
