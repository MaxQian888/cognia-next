import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIMessageRenderer } from "./a2ui-message-renderer"
import { resetStore } from "@/lib/storybook/seed-stores"
import { makeSimplifiedSpec } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

const a2uiBlock = `Here is the widget you asked for:

\`\`\`json
${JSON.stringify(makeSimplifiedSpec("msg-demo"), null, 2)}
\`\`\`
`

// A2UIMessageRenderer detects and renders A2UI JSON embedded in chat message
// content, falling back to plain text when there is none.
const meta = {
  title: "A2UI/MessageRenderer",
  component: A2UIMessageRenderer,
  parameters: { layout: "centered" },
  args: {
    messageId: "msg-demo",
    content: "Just a plain assistant message with no embedded UI.",
    onAction: fn(),
    onDataChange: fn(),
  },
  beforeEach: () => {
    resetStore(useA2UIStore)
  },
  decorators: [
    (Story) => (
      <div className="w-[460px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof A2UIMessageRenderer>

export default meta
type Story = StoryObj<typeof meta>

export const PlainText: Story = {}

export const WithEmbeddedA2UI: Story = {
  args: { content: a2uiBlock },
}
