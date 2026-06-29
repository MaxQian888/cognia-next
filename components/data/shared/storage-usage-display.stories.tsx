import type { Meta, StoryObj } from "@storybook/nextjs"

import { StorageUsageDisplay } from "./storage-usage-display"
import { seedDb } from "@/lib/storybook/seed-db"

// Compact storage stats card — reads `useStorageStats` (per-table row counts +
// the IDB origin's estimated usage/quota when the browser exposes it). The
// built-in seed gives a few non-zero table counts.
const meta = {
  title: "Data/StorageUsageDisplay",
  component: StorageUsageDisplay,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StorageUsageDisplay>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
