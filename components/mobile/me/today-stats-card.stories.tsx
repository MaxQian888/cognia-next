import type { Meta, StoryObj } from "@storybook/nextjs"

import { TodayStatsCard } from "./today-stats-card"

// Stat tiles for the /me header. All numbers come from injectable loaders
// (default loaders hit Dexie + storage estimate). Stories drive the fresh,
// rich-usage, and stale-backup variants.
const meta = {
  title: "Mobile/Me/TodayStatsCard",
  component: TodayStatsCard,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] overflow-y-auto border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TodayStatsCard>

export default meta
type Story = StoryObj<typeof meta>

export const FreshInstall: Story = {
  args: {
    loaders: {
      sessionCount: async () => 0,
      pendingDrafts: async () => 0,
      backupHealth: async () => ({ status: "never", lastSuccessAt: null }),
      storageBytes: async () => 8 * 1024 * 1024,
      usageTotals: async () => ({ tokens: 0, costUsd: 0 }),
    },
  },
}

export const WithUsage: Story = {
  args: {
    loaders: {
      sessionCount: async () => 42,
      pendingDrafts: async () => 3,
      backupHealth: async () => ({ status: "ok", lastSuccessAt: Date.now() - 3 * 60 * 60 * 1000 }),
      storageBytes: async () => 256 * 1024 * 1024,
      usageTotals: async () => ({ tokens: 1_840_000, costUsd: 6.42 }),
    },
  },
}

export const StaleBackup: Story = {
  args: {
    loaders: {
      sessionCount: async () => 12,
      pendingDrafts: async () => 0,
      backupHealth: async () => ({ status: "stale", lastSuccessAt: Date.now() - 20 * 86_400_000 }),
      storageBytes: async () => 96 * 1024 * 1024,
      usageTotals: async () => ({ tokens: 120_000, costUsd: 0.51 }),
    },
  },
}
