import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { StorageBreakdownCard, type StorageBreakdownCardProps } from "./storage-breakdown-card"
import { StorageManager } from "@/lib/storage"
import type { StorageHealth, StorageStats } from "@/lib/storage"

// `StorageBreakdownCard` is props-driven (its data comes from
// `useStorageOverview` on the page), so the stories feed a fixture instead of
// walking the empty Storybook IndexedDB.
const MB = 1024 * 1024

const stats: StorageStats = {
  total: { used: 150 * MB, quota: 2048 * MB, usagePercent: 7.3 },
  byCategory: [
    { category: "chat", displayName: "Messages", itemCount: 4210, totalSize: 96 * MB, sources: [] },
    { category: "artifact", displayName: "Artifacts", itemCount: 38, totalSize: 22 * MB, sources: [] },
    { category: "session", displayName: "Sessions", itemCount: 120, totalSize: 14 * MB, sources: [] },
    { category: "vector", displayName: "Vectors", itemCount: 900, totalSize: 9 * MB, sources: [] },
    { category: "skill", displayName: "Skills", itemCount: 12, totalSize: 5 * MB, sources: [] },
    { category: "settings", displayName: "Settings", itemCount: 1, totalSize: 2 * MB, sources: [] },
    { category: "mcp", displayName: "MCP", itemCount: 0, totalSize: 0, sources: [] },
  ],
  localStorage: { used: 0 },
  indexedDB: { used: 150 * MB },
  generatedAt: Date.now(),
}

const healthy: StorageHealth = { status: "healthy", usagePercent: 8.8, issues: [], recommendations: [] }

const meta = {
  title: "Mobile/Me/StorageBreakdownCard",
  component: StorageBreakdownCard,
  parameters: { layout: "fullscreen" },
  args: {
    stats,
    health: healthy,
    isLoading: false,
    formatBytes: StorageManager.formatBytes,
    onClearCategory: fn(async () => 12),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] overflow-y-auto border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<StorageBreakdownCardProps>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Empty: Story = {
  args: { stats: { ...stats, byCategory: [] } },
}

export const Loading: Story = {
  args: { stats: null, health: null, isLoading: true },
}
