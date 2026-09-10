import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpLiveSessionCard } from "./mcp-live-session-card"

// Host-profile-branching + chat-store reading. The card is reachable-host +
// Anthropic + open-session only: it calls the Agent SDK control method
// `mcpServerStatus()` and renders `null` whenever the host profile has no
// sidecar to ask (a standalone browser), there is no active session, or the
// control call rejects (the ai-sdk path). The Storybook browser is a
// standalone shell with no paired host, so this always renders nothing — there
// is no such branch to show. Kept as a documented Default so the component is
// represented in Storybook; its populated UI is exercised in the desktop shell
// or on a companion paired to a host.
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
