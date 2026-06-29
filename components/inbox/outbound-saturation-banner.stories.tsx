import type { Meta, StoryObj } from "@storybook/nextjs"

import { OutboundSaturationBanner } from "./outbound-saturation-banner"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeAuditEntry } from "@/lib/storybook/fixtures/inbox"

// Appears when a single adapter accumulates >= 100 `outbound.queue_capped`
// audit rows within the last 24h. Seed enough rows to cross the threshold;
// renders nothing below it.
const meta = {
  title: "Inbox/OutboundSaturationBanner",
  component: OutboundSaturationBanner,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof OutboundSaturationBanner>

export default meta
type Story = StoryObj<typeof meta>

const cappedRows = (adapterId: string, n: number) =>
  Array.from({ length: n }, (_, i) =>
    makeAuditEntry({ adapterId, at: Date.now() - i * 1_000, kind: "outbound.queue_capped" })
  )

export const Saturated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.connectorAudit.bulkPut(cappedRows("slack-acme", 120))
    })
  },
}

// Below the 100-row threshold → renders nothing.
export const BelowThreshold: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.connectorAudit.bulkPut(cappedRows("slack-acme", 10))
    })
  },
  render: () => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing below threshold → <OutboundSaturationBanner />
    </div>
  ),
}
