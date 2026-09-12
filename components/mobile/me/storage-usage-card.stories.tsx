import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { StorageUsageCard, type StorageUsageCardProps } from "./storage-usage-card"
import type { StorageHealth, StorageStats } from "@/lib/storage"
import type { StorageUsage } from "@/lib/storage/usage"

// `StorageUsageCard` is props-driven (its data comes from `useStorageOverview`
// on the page), so the stories feed fixtures for the supported / unsupported /
// not-yet-persisted / near-full branches.
const MB = 1024 * 1024

const usage: StorageUsage = {
  totalBytes: 180 * MB,
  quotaBytes: 2048 * MB,
  backupBytes: 12 * MB,
  backups: [],
}

const stats: StorageStats = {
  total: { used: 150 * MB, quota: 2048 * MB, usagePercent: 7.3 },
  byCategory: [
    { category: "chat", displayName: "Messages", itemCount: 4210, totalSize: 96 * MB, sources: [] },
    { category: "artifact", displayName: "Artifacts", itemCount: 38, totalSize: 22 * MB, sources: [] },
    { category: "session", displayName: "Sessions", itemCount: 120, totalSize: 14 * MB, sources: [] },
    { category: "vector", displayName: "Vectors", itemCount: 900, totalSize: 9 * MB, sources: [] },
    { category: "skill", displayName: "Skills", itemCount: 12, totalSize: 5 * MB, sources: [] },
    { category: "settings", displayName: "Settings", itemCount: 1, totalSize: 2 * MB, sources: [] },
    { category: "backupHistory", displayName: "Backups", itemCount: 3, totalSize: 2 * MB, sources: [] },
  ],
  localStorage: { used: 0 },
  indexedDB: { used: 150 * MB },
  generatedAt: Date.now(),
}

const healthy: StorageHealth = { status: "healthy", usagePercent: 8.8, issues: [], recommendations: [] }

const meta = {
  title: "Mobile/Me/StorageUsageCard",
  component: StorageUsageCard,
  parameters: { layout: "fullscreen" },
  args: {
    usage,
    stats,
    health: healthy,
    persisted: true,
    isLoading: false,
    refreshing: false,
    onRefresh: fn(),
    onRequestPersistence: fn(async () => "persisted" as const),
  },
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

export const Persisted: Story = {}

export const NotPersisted: Story = {
  args: { persisted: false },
}

export const NearlyFull: Story = {
  args: {
    usage: { ...usage, totalBytes: 1900 * MB },
    health: { status: "critical", usagePercent: 92.8, issues: [], recommendations: [] },
  },
}

export const Unsupported: Story = {
  args: {
    usage: { totalBytes: null, quotaBytes: null, backupBytes: null, backups: [] },
    persisted: false,
  },
}

export const Loading: Story = {
  args: { usage: null, stats: null, health: null, persisted: null, isLoading: true },
}
