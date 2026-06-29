import type { Meta, StoryObj } from "@storybook/nextjs"

import { PairedDevicesCard } from "./paired-devices-card"
import { seedDb, clearDb } from "@/lib/storybook/seed-db"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

// Reads the `pairedDevices` Dexie table via `useLiveQuery`. With the fresh
// in-browser IndexedDB the card renders its empty state; the Populated story
// seeds a spread of active / paused / revoked rows so the table, the
// remote-control switch and the pause/resume/revoke actions all render.
const HOUR = 3_600_000

function rows(now: number): PairedDeviceRow[] {
  return [
    {
      deviceId: "11111111-1111-4111-8111-111111111111",
      label: "Max's iPhone 15",
      platform: "ios",
      pubkey: "spki-a",
      appVersion: "1.4.0",
      pairedAt: now - 48 * HOUR,
      lastSeenAt: now - 2 * HOUR,
      allowRemoteControl: true,
      serverFingerprint: "ab".repeat(32),
    },
    {
      deviceId: "22222222-2222-4222-8222-222222222222",
      label: "Pixel 8 (work)",
      platform: "android",
      pubkey: "spki-b",
      appVersion: "1.3.2",
      pairedAt: now - 72 * HOUR,
      lastSeenAt: now - 30 * HOUR,
      pausedAt: now - 1 * HOUR,
    },
    {
      deviceId: "33333333-3333-4333-8333-333333333333",
      label: "Old tablet",
      platform: "android",
      pubkey: "spki-c",
      appVersion: "1.1.0",
      pairedAt: now - 200 * HOUR,
      lastSeenAt: now - 150 * HOUR,
      revokedAt: now - 100 * HOUR,
    },
  ]
}

const meta = {
  title: "Settings/Companion/PairedDevicesCard",
  component: PairedDevicesCard,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await clearDb()
  },
} satisfies Meta<typeof PairedDevicesCard>

export default meta
type Story = StoryObj<typeof meta>

// Fresh DB → "no paired devices yet" empty copy.
export const Empty: Story = {}

// Three devices: an active iPhone with remote control on, a paused Pixel, and
// a revoked tablet. Exercises every badge + action affordance in the table.
export const Populated: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.pairedDevices.bulkPut(rows(Date.now()))
    })
  },
}
