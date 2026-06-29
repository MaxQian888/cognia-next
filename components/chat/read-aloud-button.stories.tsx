import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactElement } from "react"

import { ReadAloudButton } from "./read-aloud-button"
import { MessageActions } from "@/components/ai-elements/message"

// Per-message "read aloud" control for assistant messages. Idle by default
// (speaker icon); becomes active/loading while the TTS orchestrator speaks.
// Wrapped in MessageActions to mirror its real mount site.
function withActions(Story: () => ReactElement) {
  return (
    <MessageActions>
      <Story />
    </MessageActions>
  )
}

const meta = {
  title: "Chat/ReadAloudButton",
  component: ReadAloudButton,
  parameters: { layout: "centered" },
  decorators: [withActions],
  args: {
    messageId: "msg-1",
    text: "Closures let a function remember the scope it was created in.",
    character: null,
  },
} satisfies Meta<typeof ReadAloudButton>

export default meta
type Story = StoryObj<typeof meta>

/** Idle — the speaker icon; click to start reading. */
export const Idle: Story = {}

/** A longer message body still renders the same compact control. */
export const LongMessage: Story = {
  args: {
    text: "Here is a longer answer that the read-aloud control would synthesize into speech when activated by the user.",
  },
}
