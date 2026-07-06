import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpLiveSessionCard } from "./mcp-live-session-card"

// Tauri-branching + chat-store reading. The card is desktop + Anthropic +
// open-session only: it calls the Agent SDK control method `mcpServerStatus()`
// and renders `null` whenever `!isTauri()`, there is no active session, or the
// control call rejects (the ai-sdk / web path). In the Storybook browser
// isTauri() is false, so this always renders nothing — there is no web branch to
// show. Kept as a documented Default so the component is represented in
// Storybook; its populated UI can only be exercised inside the Tauri shell.
const meta = {
  title: "Settings/MCP/McpLiveSessionCard",
  component: McpLiveSessionCard,
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpLiveSessionCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
