import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginAnalytics } from "./plugin-analytics"
import { seedDb } from "@/lib/storybook/seed-db"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"

// Per-plugin (or all-plugin) analytics panel. Reads `pluginAnalytics` rows via a
// Dexie live query and rolls them up into summary cards + a per-key table. With
// an empty store it shows the empty-state card.

const now = Date.parse("2025-06-20T12:00:00.000Z")

const meta = {
  title: "Plugins/Detail/PluginAnalytics",
  component: PluginAnalytics,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginAnalytics>

export default meta
type Story = StoryObj<typeof meta>

// Seeded counters across two plugins → summary cards + table.
export const WithData: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
      await db.pluginAnalytics.bulkPut([
        { pluginId: "com.acme.web-tools", key: "tool.invoke", count: 142, lastEventAt: now },
        {
          pluginId: "com.acme.web-tools",
          key: "command.run",
          count: 23,
          lastEventAt: now - 3600_000,
        },
        { pluginId: "com.acme.web-tools", key: "error", count: 4, lastEventAt: now - 7200_000 },
        { pluginId: "com.acme.ocr", key: "tool.invoke", count: 57, lastEventAt: now - 1800_000 },
      ])
    })
  },
}

// Narrowed to a single plugin via `pluginId`.
export const SinglePlugin: Story = {
  args: { pluginId: "com.acme.web-tools" },
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
      await db.pluginAnalytics.bulkPut([
        { pluginId: "com.acme.web-tools", key: "tool.invoke", count: 142, lastEventAt: now },
        { pluginId: "com.acme.web-tools", key: "error", count: 4, lastEventAt: now - 7200_000 },
      ])
    })
  },
}

// No analytics rows → the empty-state card.
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
