import type { Meta, StoryObj } from "@storybook/nextjs"

import { CodexAppServerStatusCard } from "./codex-app-server-status-card"

// `CodexAppServerStatusCard` is a read-only diagnostics surface for a connected
// native Codex `app-server` agent. It pulls the live MCP-server + skill snapshot
// from the external-agent manager via `useCodexAppServerStatus`. Outside Tauri
// (and whenever the agent isn't connected through the app-server protocol) the
// adapter is absent, so the card renders its "not connected" placeholder — the
// branch a Storybook web preview always exercises.
const meta = {
  title: "Settings/Agent/CodexAppServerStatusCard",
  component: CodexAppServerStatusCard,
  parameters: { layout: "padded" },
  args: {
    agentId: "codex-app-server-1",
    connected: false,
  },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CodexAppServerStatusCard>

export default meta
type Story = StoryObj<typeof meta>

// Agent not connected — the card shows the dashed "not connected" notice.
export const Disconnected: Story = {}

// Marked connected, but on the web preview no app-server adapter exists, so the
// card still falls back to the "not connected" notice (the live MCP/skill grid
// only appears inside the Tauri shell with a live Codex app-server session).
export const ConnectedWebFallback: Story = {
  args: { connected: true },
}
