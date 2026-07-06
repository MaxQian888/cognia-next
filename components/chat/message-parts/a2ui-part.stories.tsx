import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import type { A2UIPart as A2UIPartType } from "@/lib/claude/parts-extensions"

import { A2UIPart } from "./a2ui-part"

// A2UIPart drives the *real* A2UI message pipeline: it parses `part.content`
// (a JSON surface spec), registers a surface in the live `useA2UIStore`, and
// renders `<A2UIInlineSurface>`. No mocking — the spec below is the simplified
// payload shape the parser accepts as tool/message content.
const SPEC = JSON.stringify({
  surface: { id: "story-a2ui", type: "inline", title: "Quick poll" },
  components: [
    { id: "root", component: "Card", title: "Quick poll", children: ["q", "yes", "no"] },
    { id: "q", component: "Text", text: "Should we ship the routing fix today?" },
    { id: "yes", component: "Button", text: "Ship it", action: "ship" },
    { id: "no", component: "Button", text: "Hold", action: "hold" },
  ],
  dataModel: {},
})

const part: A2UIPartType = {
  type: "a2ui",
  surfaceId: "story-a2ui",
  content: SPEC,
  source: "tool-result",
}

const meta = {
  title: "Chat/MessageParts/A2UIPart",
  component: A2UIPart,
  parameters: { layout: "padded" },
  args: { part, onAction: fn(), onDataChange: fn() },
} satisfies Meta<typeof A2UIPart>

export default meta
type Story = StoryObj<typeof meta>

// Renders the interactive surface inline once the JSON is processed.
export const InteractiveSurface: Story = {}

// A simpler single-text surface (e.g. an MCP-bridged result).
export const TextSurface: Story = {
  args: {
    part: {
      type: "a2ui",
      surfaceId: "story-a2ui-text",
      content: JSON.stringify({
        surface: { id: "story-a2ui-text", type: "inline", title: "Result" },
        components: [
          { id: "root", component: "Card", title: "Result", children: ["t"] },
          { id: "t", component: "Text", text: "Rendered from an A2UI tool result." },
        ],
        dataModel: {},
      }),
      source: "mcp-bridge",
    },
  },
}
