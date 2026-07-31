import type { Meta, StoryObj } from "@storybook/nextjs"

import { StreamingTextPart } from "./streaming-text-part"

// The actively-streaming text branch of MessageRenderer — Streamdown markdown
// plus a blinking caret signalling that more tokens are arriving.
const meta = {
  title: "Chat/StreamingTextPart",
  component: StreamingTextPart,
  parameters: { layout: "padded" },
  args: {
    text: "Closures let a function remember the lexical scope it was created in",
    isStreaming: true,
  },
} satisfies Meta<typeof StreamingTextPart>

export default meta
type Story = StoryObj<typeof meta>

/** Mid-stream: partial text followed by the animated caret. */
export const Streaming: Story = {}

/** Markdown mid-stream — headings and lists render as they arrive. */
export const WithMarkdown: Story = {
  args: {
    text: "## Plan\n\n1. Read the file\n2. Apply the edit\n3. Run the tests",
  },
}

/** A short partial token — the caret sits right after the first word. */
export const EarlyTokens: Story = {
  args: { text: "Let me" },
}
