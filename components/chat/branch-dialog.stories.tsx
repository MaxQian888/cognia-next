import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { BranchDialog } from "./branch-dialog"

// Conversation-branching modal. At render it shows the "direct vs summary" mode
// picker over a Dialog. Summary generation (LLM) only fires on user interaction,
// so the default open state renders without touching the sidecar. We seed the
// chat store so the visible-message lookup at confirm time has something to cut.

const meta = {
  title: "Chat/BranchDialog",
  component: BranchDialog,
  parameters: { layout: "fullscreen" },
  args: {
    sessionId: "demo-session",
    messageId: "m-3",
    open: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof BranchDialog>

export default meta
type Story = StoryObj<typeof meta>

// The dialog open on its default "direct branch" mode.
export const Open: Story = {}
