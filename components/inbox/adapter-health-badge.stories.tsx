import type { Meta, StoryObj } from "@storybook/nextjs"

import { AdapterHealthBadge } from "./adapter-health-badge"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeHeartbeat } from "@/lib/storybook/fixtures/inbox"

const ADAPTER_ID = "story-adapter"

// "Quiet when healthy, loud when not" — the badge renders nothing unless the
// adapter's derived health is non-nominal. Health is derived from the latest
// `connectorHeartbeats` snapshot, so seed a heartbeat with a tripped breaker /
// exhausted rate bucket to make the badge appear. The Reconnect action is
// Tauri-only and toasts "desktop only" in the Storybook web shell.
const meta = {
  title: "Inbox/AdapterHealthBadge",
  component: AdapterHealthBadge,
  args: { adapterId: ADAPTER_ID },
  parameters: { layout: "padded" },
} satisfies Meta<typeof AdapterHealthBadge>

export default meta
type Story = StoryObj<typeof meta>

export const BreakerOpen: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.connectorHeartbeats.put(
        makeHeartbeat({
          adapterId: ADAPTER_ID,
          at: Date.now(),
          fields: {
            state: "degraded",
            breakerState: "open",
            breakerOpenedAt: Date.now() - 60_000,
            breakerFailureRate: 0.8,
            breakerEventCount: 12,
          },
        })
      )
    })
  },
}

export const RateLimited: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.connectorHeartbeats.put(
        makeHeartbeat({
          adapterId: ADAPTER_ID,
          at: Date.now(),
          fields: {
            state: "degraded",
            rateCapacity: 60,
            rateAvailable: 0,
            rateRefillPerSec: 1,
            rateNextRefillAt: Date.now() + 30_000,
          },
        })
      )
    })
  },
}

// Healthy adapter (or no data) → renders nothing.
export const Nominal: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing when healthy → <AdapterHealthBadge {...args} />
    </div>
  ),
}
