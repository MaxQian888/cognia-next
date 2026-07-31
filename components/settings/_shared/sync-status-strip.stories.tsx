import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { SyncStatusStrip } from "./sync-status-strip"

const meta = {
  title: "Settings/SyncStatusStrip",
  component: SyncStatusStrip,
  args: {
    label: "Sync from models.dev",
    syncingLabel: "Syncing…",
    syncedLabel: "Synced",
    phase: "idle",
    summary: "Last synced 2h ago · 412 models",
    onSync: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SyncStatusStrip>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {}

export const Syncing: Story = {
  args: { phase: "syncing", statusText: "Fetching catalog… 212 / 412" },
}

export const Error: Story = {
  args: { phase: "error", statusText: "Network unreachable — try again." },
}

export const Stale: Story = {
  args: { phase: "stale", statusText: "Catalog is 9 days old" },
}

export const Success: Story = {
  args: { phase: "success" },
}

export const Disabled: Story = {
  args: { disabled: true },
}
