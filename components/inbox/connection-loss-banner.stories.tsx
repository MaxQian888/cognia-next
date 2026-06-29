import type { Meta, StoryObj } from "@storybook/nextjs"

import { ConnectionLossBanner } from "./connection-loss-banner"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeHeartbeat } from "@/lib/storybook/fixtures/inbox"

// The banner groups recent (<5 min) `connectorHeartbeats` by adapter and shows
// only those whose newest snapshot is `degraded` / `down`. It renders nothing
// when every adapter is healthy. Reconnect is Tauri-only (disabled in web).
const meta = {
  title: "Inbox/ConnectionLossBanner",
  component: ConnectionLossBanner,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ConnectionLossBanner>

export default meta
type Story = StoryObj<typeof meta>

export const SingleDegraded: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.connectorHeartbeats.put(
        makeHeartbeat({
          adapterId: "slack-acme",
          at: Date.now() - 10_000,
          fields: { state: "degraded", reason: "websocket reconnecting" },
        })
      )
    })
  },
}

export const MultipleDown: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.connectorHeartbeats.bulkPut([
        makeHeartbeat({
          adapterId: "slack-acme",
          at: Date.now() - 10_000,
          fields: { state: "down", reason: "auth expired" },
        }),
        makeHeartbeat({
          adapterId: "telegram-ops",
          at: Date.now() - 5_000,
          fields: { state: "degraded", reason: "rate limited upstream" },
        }),
      ])
    })
  },
}

// All adapters healthy → renders nothing.
export const Healthy: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.connectorHeartbeats.put(
        makeHeartbeat({ adapterId: "slack-acme", at: Date.now(), fields: { state: "running" } })
      )
    })
  },
  render: () => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing when healthy → <ConnectionLossBanner />
    </div>
  ),
}
