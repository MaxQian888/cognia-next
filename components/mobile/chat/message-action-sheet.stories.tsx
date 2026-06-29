import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MessageActionSheet } from "./message-action-sheet"
import { makeUIMessage } from "@/lib/storybook/fixtures/mobile"

// Long-press per-message action drawer (copy / quote / share / branch). Pure:
// the sheet is open whenever `message !== null`; the Branch row only appears
// when the message metadata carries a `sessionId`. Clipboard / share fire only
// on taps.
const meta = {
  title: "Mobile/Chat/MessageActionSheet",
  component: MessageActionSheet,
  parameters: { layout: "fullscreen" },
  args: { onOpenChange: fn() },
} satisfies Meta<typeof MessageActionSheet>

export default meta
type Story = StoryObj<typeof meta>

/** Copy / quote / share for an assistant message. */
export const Default: Story = {
  args: { message: makeUIMessage() },
}

/** Message bound to a session — adds the "Branch" action. */
export const WithBranch: Story = {
  args: {
    message: makeUIMessage({ metadata: { sessionId: "session-1" } }),
  },
}
