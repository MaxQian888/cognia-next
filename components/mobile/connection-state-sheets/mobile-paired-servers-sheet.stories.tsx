import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MobilePairedServersSheet } from "./mobile-paired-servers-sheet"
import { seedDb } from "@/lib/storybook/seed-db"
import { makePairedDevice } from "@/lib/storybook/fixtures/pair"

// Switch-server sheet. Reads the local Dexie `pairedDevices` table via
// `useClientLiveQuery` and filters out revoked rows. Empty DB → empty state;
// the seeded story inserts a couple of known desktops.
const meta = {
  title: "Mobile/ConnectionStateSheets/MobilePairedServersSheet",
  component: MobilePairedServersSheet,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof MobilePairedServersSheet>

export default meta
type Story = StoryObj<typeof meta>

/** No paired desktops recorded yet. */
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

/** Two known desktops the user can switch between. */
export const WithDevices: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.pairedDevices.bulkPut([
        makePairedDevice({ label: "Studio Mac", platform: "ios" }),
        makePairedDevice({ label: "Office PC", platform: "android" }),
      ])
    })
  },
}
