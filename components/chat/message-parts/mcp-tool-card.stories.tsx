import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { MCPToolCard } from "./mcp-tool-card"

// MCPToolCard routes a tool part to its structured sub-renderer by tool name,
// falling back to the generic ToolBody for unknown tools.
const readPart: ToolUIPart = {
  type: "tool-Read",
  toolCallId: "call-read",
  state: "output-available",
  input: { file_path: "app/page.tsx" },
  output:
    "export default function Home() {\n  return isMobile() ? <AppShellMobile /> : <DesktopChatWorkspace />\n}",
} as unknown as ToolUIPart

const grepPart: ToolUIPart = {
  type: "tool-Grep",
  toolCallId: "call-grep",
  state: "output-available",
  input: { pattern: "useChatStore", glob: "**/*.tsx" },
  output: "components/chat/chat-view.tsx:9\ncomponents/chat/message-list.tsx:42",
} as unknown as ToolUIPart

const webSearchPart: ToolUIPart = {
  type: "tool-WebSearch",
  toolCallId: "call-ws",
  state: "output-available",
  input: { query: "Next.js 16 static export limitations" },
  output: JSON.stringify({
    results: [
      {
        title: "Static Exports",
        url: "https://nextjs.org/docs/app/building-your-application/deploying/static-exports",
      },
    ],
  }),
} as unknown as ToolUIPart

const unknownPart: ToolUIPart = {
  type: "tool-SomeThirdPartyTool",
  toolCallId: "call-x",
  state: "output-available",
  input: { foo: "bar" },
  output: "plain string output",
} as unknown as ToolUIPart

const meta = {
  title: "Chat/MessageParts/MCPToolCard",
  component: MCPToolCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof MCPToolCard>

export default meta
type Story = StoryObj<typeof meta>

// Known built-in `Read` → structured ReadCard.
export const ReadTool: Story = {
  args: { part: readPart },
}

// Known built-in `Grep` → structured GrepCard.
export const GrepTool: Story = {
  args: { part: grepPart },
}

// `WebSearch` → structured WebSearchCard.
export const WebSearchTool: Story = {
  args: { part: webSearchPart },
}

// Unregistered tool → generic ToolBody fallback.
export const UnknownToolFallback: Story = {
  args: { part: unknownPart },
}
