import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SyncStatusPanel, type SyncStatusPanelProps } from "./sync-status-panel"
import { snapshotSyncStates } from "@/lib/sync/companion-sync"

type Snapshot = ReturnType<typeof snapshotSyncStates>

// `SyncStatusPanel` reads the in-memory companion-sync snapshot via an
// injectable `reader` and triggers pulls via `trigger`. The stories feed a
// fabricated per-table snapshot (the real orchestrator is dormant in the
// Storybook browser) and a no-op trigger.
function makeSnapshot(over: Record<string, { lastSyncAt: number | null; lastError: string | null }>): Snapshot {
  const base: Record<string, { lastSyncAt: number | null; since: number; lastError: string | null }> = {}
  for (const [table, v] of Object.entries(over)) {
    base[table] = { lastSyncAt: v.lastSyncAt, since: 0, lastError: v.lastError }
  }
  return base as Snapshot
}

const meta = {
  title: "Mobile/Me/SyncStatusPanel",
  component: SyncStatusPanel,
  parameters: { layout: "fullscreen" },
  args: {
    trigger: fn(async () => undefined),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<SyncStatusPanelProps>

export default meta
type Story = StoryObj<typeof meta>

export const Healthy: Story = {
  args: {
    reader: () =>
      makeSnapshot({
        sessions: { lastSyncAt: Date.now() - 30_000, lastError: null },
        messages: { lastSyncAt: Date.now() - 90_000, lastError: null },
        characters: { lastSyncAt: Date.now() - 5 * 60_000, lastError: null },
        workflows: { lastSyncAt: Date.now() - 60 * 60_000, lastError: null },
      }),
  },
}

export const WithErrorsAndNever: Story = {
  args: {
    reader: () =>
      makeSnapshot({
        sessions: { lastSyncAt: Date.now() - 30_000, lastError: null },
        messages: { lastSyncAt: null, lastError: "Connection reset by peer" },
        characters: { lastSyncAt: null, lastError: null },
      }),
  },
}
