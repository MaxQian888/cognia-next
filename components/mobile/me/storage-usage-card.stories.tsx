import type { Meta, StoryObj } from "@storybook/nextjs"

import { StorageUsageCard, type StorageUsageCardProps } from "./storage-usage-card"
import type { StorageUsage } from "@/lib/storage/usage"
import type { BackupHistoryRow } from "@/lib/db/backup-history"

// `StorageUsageCard` resolves usage + persistence via injectable seams
// (`navigator.storage.estimate()` is unavailable in the Storybook browser).
// The stories feed fixtures to render the supported / unsupported / not-yet-
// persisted branches.
function backup(over: Partial<BackupHistoryRow>): BackupHistoryRow {
  return {
    id: "bk-1",
    completedAt: Date.now() - 2 * 60 * 60 * 1000,
    type: "manual",
    success: true,
    encryption: "auto-key",
    sizeBytes: 4 * 1024 * 1024,
    filename: "cognia-backup.json",
    schemaVersion: 3,
    ...over,
  }
}

const supportedUsage: StorageUsage = {
  totalBytes: 180 * 1024 * 1024,
  quotaBytes: 2 * 1024 * 1024 * 1024,
  backupBytes: 12 * 1024 * 1024,
  backups: [
    backup({ id: "bk-1", filename: "cognia-2026-06-29.json" }),
    backup({ id: "bk-2", filename: "cognia-2026-06-22.json", encryption: "passphrase", completedAt: Date.now() - 7 * 86_400_000 }),
  ],
}

const meta = {
  title: "Mobile/Me/StorageUsageCard",
  component: StorageUsageCard,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<StorageUsageCardProps>

export default meta
type Story = StoryObj<typeof meta>

export const Persisted: Story = {
  args: {
    fetcher: async () => supportedUsage,
    persistedChecker: async () => true,
  },
}

export const NotPersisted: Story = {
  args: {
    fetcher: async () => supportedUsage,
    persistedChecker: async () => false,
  },
}

export const Unsupported: Story = {
  args: {
    fetcher: async () => ({ totalBytes: null, quotaBytes: null, backupBytes: null, backups: [] }),
    persistedChecker: async () => false,
  },
}
