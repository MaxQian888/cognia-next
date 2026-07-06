import type { Meta, StoryObj } from "@storybook/nextjs"

import { SyncStatusCard } from "./sync-status-card"

// Renders the per-handler sync table from an in-memory snapshot of the
// companion sync state (`snapshotSyncStates`). In Storybook nothing has synced
// yet, so every row reads "never" with a healthy header badge and a "Sync now"
// button per handler. No props — the card owns its own polling loop.
const meta = {
  title: "Settings/Companion/SyncStatusCard",
  component: SyncStatusCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SyncStatusCard>

export default meta
type Story = StoryObj<typeof meta>

// Default snapshot: all handlers idle ("never" synced), healthy status badge.
export const Default: Story = {}
