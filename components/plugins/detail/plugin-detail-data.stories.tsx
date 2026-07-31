import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDetailData } from "./plugin-detail-data"
import { seedDb } from "@/lib/storybook/seed-db"
import { makePluginRow } from "@/lib/storybook/fixtures/plugins"

// Data sub-tab — a thin composition of the per-plugin operational surfaces:
// Dexie tables, scheduled jobs, analytics, backup, the rate-limit resource
// manager, and the dependency graph, each in a collapsible. Tables open by
// default; the rest are second-level collapsibles. Every child reads its own
// data by pluginId (mostly empty live queries here), so the seeded row only
// needs to exist for the pane to mount.

const PLUGIN_ID = "com.acme.web-tools"

const meta = {
  title: "Plugins/Detail/PluginDetailData",
  component: PluginDetailData,
  args: { pluginId: PLUGIN_ID },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDetailData>

export default meta
type Story = StoryObj<typeof meta>

export const Loaded: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([makePluginRow({ id: PLUGIN_ID })])
    })
  },
}

// No matching row → the "not found" message.
export const NotFound: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
