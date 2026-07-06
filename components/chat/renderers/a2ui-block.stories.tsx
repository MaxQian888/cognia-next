import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIBlock } from "./a2ui-block"

// A2UIBlock wraps a markdown ```a2ui``` fence: its `content` is the raw JSON
// body, which it forwards to the standard A2UIPart pipeline (real store).
const FENCE = JSON.stringify(
  {
    surface: { id: "story-fence", type: "inline", title: "Inline widget" },
    components: [
      { id: "root", component: "Card", title: "Inline widget", children: ["h", "b", "cta"] },
      { id: "h", component: "Text", text: "Rendered from a markdown fence", variant: "heading3" },
      {
        id: "b",
        component: "Text",
        text: "The a2ui fence renders inline where the model emitted it.",
      },
      { id: "cta", component: "Button", text: "Acknowledge", action: "ack" },
    ],
    dataModel: {},
  },
  null,
  2
)

const meta = {
  title: "Chat/Renderers/A2UIBlock",
  component: A2UIBlock,
  parameters: { layout: "padded" },
  args: { content: FENCE, messageId: "msg-1" },
} satisfies Meta<typeof A2UIBlock>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
