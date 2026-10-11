import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDetailPane } from "./plugin-detail-pane"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makePluginRow } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// Full detail pane. Reads the selected `detailPluginId` from the plugins store
// and the row itself from a Dexie live query, then renders the header, the tab
// bar, and the active tab's body. With no selection it shows the idle empty
// state (the desktop panel does not mount the pane then, the tablet sheet and
// the phone drawer close instead).

const PLUGIN_ID = "com.acme.web-tools"

const meta = {
  title: "Plugins/Detail/PluginDetailPane",
  component: PluginDetailPane,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[600px] max-w-full border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDetailPane>

export default meta
type Story = StoryObj<typeof meta>

// A plugin is selected and seeded → header + tab bar + Overview.
export const Selected: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([makePluginRow({ id: PLUGIN_ID })])
    })
    seedStore(usePluginsStore, { detailPluginId: PLUGIN_ID })
    return () => resetStore(usePluginsStore)
  },
}

// Python plugin → the Configure tab carries the Python host settings.
export const PythonPlugin: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([makePluginRow({ id: PLUGIN_ID, type: "python" })])
    })
    seedStore(usePluginsStore, { detailPluginId: PLUGIN_ID, detailSubTab: "configure" })
    return () => resetStore(usePluginsStore)
  },
}

// The inline desktop pane: a close button in the header, opened on Permissions.
export const InlineWithClose: Story = {
  args: { onClose: () => undefined },
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([makePluginRow({ id: PLUGIN_ID })])
    })
    seedStore(usePluginsStore, { detailPluginId: PLUGIN_ID, detailSubTab: "permissions" })
    return () => resetStore(usePluginsStore)
  },
}

// No selection → the idle empty state with the installed-set summary.
export const NoSelection: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
    resetStore(usePluginsStore)
  },
}
