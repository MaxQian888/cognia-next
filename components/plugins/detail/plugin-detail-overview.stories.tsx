import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDetailOverview } from "./plugin-detail-overview"
import { seedDb } from "@/lib/storybook/seed-db"
import { makePluginRow } from "@/lib/storybook/fixtures/plugins"

// Overview sub-tab: meta rows (id / version / type / source / status / author /
// links / license), lifecycle dates, the shared dependency panel, an optional
// rendered README, a verification card (driven by the in-memory PluginManager
// store — empty here, so hidden), and an error card. The plugin is read by
// `pluginId` through a Dexie live query, so stories seed the row first.

const PLUGIN_ID = "com.acme.web-tools"

const meta = {
  title: "Plugins/Detail/PluginDetailOverview",
  component: PluginDetailOverview,
  args: { pluginId: PLUGIN_ID },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDetailOverview>

export default meta
type Story = StoryObj<typeof meta>

// Full row: meta, dates, dependency panel, and a rendered README.
export const Loaded: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([makePluginRow({ id: PLUGIN_ID })])
    })
  },
}

// Errored plugin surfaces the destructive error card at the bottom.
export const Errored: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([
        makePluginRow({
          id: PLUGIN_ID,
          status: "error",
          error: "Failed to load runtime: python interpreter not found",
          readme: undefined,
        }),
      ])
    })
  },
}

// No matching row → the "not found" message.
export const NotFound: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
