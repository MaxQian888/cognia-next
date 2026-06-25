import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { ConnectionStatusBadge } from "./connection-status-badge"
import type { ExternalAgentConnectionStatus } from "@/types/agent/external-agent"

const STATUSES: ExternalAgentConnectionStatus[] = [
  "disconnected",
  "connecting",
  "connected",
  "reconnecting",
  "error",
]

const meta = {
  title: "Agent/ConnectionStatusBadge",
  component: ConnectionStatusBadge,
  args: { status: "connected" },
} satisfies Meta<typeof ConnectionStatusBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Connected: Story = {}

export const AllStatuses: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {STATUSES.map((s) => (
        <ConnectionStatusBadge key={s} status={s} />
      ))}
    </div>
  ),
}

// withIcon adds a leading glyph for connected/error only.
export const WithIcon: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {STATUSES.map((s) => (
        <ConnectionStatusBadge key={s} status={s} withIcon />
      ))}
    </div>
  ),
}
