import type { Meta, StoryObj } from "@storybook/nextjs"

import { StorageOverview, type StorageOverviewProps } from "./storage-overview"
import { seedDb } from "@/lib/storybook/seed-db"
import type { StorageUsage } from "@/lib/storage/usage"

// `StorageOverview` owns `useStorageOverview`. The origin estimate and the
// persistence probe are injected (unavailable in the Storybook browser); the
// per-category walk runs against the seeded Storybook IndexedDB.
const MB = 1024 * 1024
const usage: StorageUsage = {
  totalBytes: 180 * MB,
  quotaBytes: 2048 * MB,
  backupBytes: 12 * MB,
  backups: [
    {
      id: "bk-1",
      completedAt: Date.now() - 2 * 60 * 60 * 1000,
      type: "manual",
      success: true,
      encryption: "auto-key",
      sizeBytes: 12 * MB,
      filename: "cognia-backup.json",
      schemaVersion: 3,
    },
  ],
}

const meta = {
  title: "Mobile/Me/StorageOverview",
  component: StorageOverview,
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    await seedDb(async () => {})
  },
  args: {
    fetcher: async () => usage,
    persistedChecker: async () => false,
    requester: async () => "persisted" as const,
  },
} satisfies Meta<StorageOverviewProps>

export default meta
type Story = StoryObj<typeof meta>

export const Phone: Story = {
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto border p-4">
        <Story />
      </div>
    ),
  ],
}

export const Tablet: Story = {
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[900px] overflow-y-auto border p-4">
        <Story />
      </div>
    ),
  ],
}
