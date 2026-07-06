import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"
import type { McpResultBlock } from "@/lib/claude/parts-extensions"

import { McpContentBlocksCard } from "./mcp-content-blocks-card"

const part = {
  type: "tool-some_mcp_tool",
  toolCallId: "call-1",
  state: "output-available",
  input: { query: "diagram of the pipeline" },
} as unknown as ToolUIPart

const IMG =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='120'><rect width='100%' height='100%' fill='#0ea5e9'/><text x='50%' y='50%' fill='white' font-size='18' text-anchor='middle' dy='.3em'>MCP image</text></svg>`
  )

const textBlocks: McpResultBlock[] = [
  {
    type: "text",
    text: "## Result\n\nThe **pipeline** has three stages:\n\n1. ingest\n2. embed\n3. route",
  },
]

const mixedBlocks: McpResultBlock[] = [
  { type: "text", text: "Generated diagram and source below." },
  { type: "image", data: IMG },
  {
    type: "resource",
    resource: {
      uri: "file:///tmp/pipeline.ts",
      mimeType: "text/typescript",
      text: "export const stages = ['ingest', 'embed', 'route'] as const",
    },
  },
]

const meta = {
  title: "Chat/MessageParts/McpRenderers/McpContentBlocksCard",
  component: McpContentBlocksCard,
  parameters: { layout: "padded" },
  args: { part },
} satisfies Meta<typeof McpContentBlocksCard>

export default meta
type Story = StoryObj<typeof meta>

// A text block rendered as markdown, above the tool input.
export const TextBlocks: Story = {
  args: { blocks: textBlocks },
}

// Mixed content — markdown, inline image, and an embedded code resource.
export const MixedContent: Story = {
  args: { blocks: mixedBlocks },
}
