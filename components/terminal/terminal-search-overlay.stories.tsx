import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TerminalSearchOverlay } from "./terminal-search-overlay"
import type { TerminalInstanceHandle } from "./terminal-instance"

// Compact find-overlay rendered over the active terminal. It drives the xterm
// search addon through an imperative ref; in isolation we hand it a stub handle
// so the find/case/next/prev controls render and respond without a live terminal.
const stubHandle: TerminalInstanceHandle = {
  findNext: () => true,
  findPrevious: () => true,
  clearSearch: () => {},
} as unknown as TerminalInstanceHandle

const meta = {
  title: "Terminal/SearchOverlay",
  component: TerminalSearchOverlay,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onClose: fn(),
    instanceRef: { current: stubHandle },
  },
  decorators: [
    (Story) => (
      <div className="relative h-48 w-full bg-[#1f2430]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalSearchOverlay>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Closed: Story = { args: { open: false } }
