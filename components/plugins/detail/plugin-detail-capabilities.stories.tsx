import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDetailCapabilities } from "./plugin-detail-capabilities"
import { seedDb } from "@/lib/storybook/seed-db"
import { makePluginRow } from "@/lib/storybook/fixtures/plugins"

// Capabilities sub-tab — composes the manifest capability badges, declared
// contributions and activation events, the CLI-tools section, the runtime
// contributions registry, and the workflow triggers panel. The registry-backed
// sections (contributed / triggers) read in-memory plugin registries that are
// empty in Storybook, so they render their own empty states; the manifest-driven
// cards are fully painted from the seeded row.

const PLUGIN_ID = "com.acme.web-tools"

const meta = {
  title: "Plugins/Detail/PluginDetailCapabilities",
  component: PluginDetailCapabilities,
  args: { pluginId: PLUGIN_ID },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDetailCapabilities>

export default meta
type Story = StoryObj<typeof meta>

// Capabilities, contributions and activation events all present.
export const Loaded: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([makePluginRow({ id: PLUGIN_ID })])
    })
  },
}

// A plugin that declares no capabilities/contributions → the "no capabilities"
// note replaces the overview cards.
export const NoCapabilities: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([
        makePluginRow({
          id: PLUGIN_ID,
          capabilities: [],
          manifest: { id: PLUGIN_ID, name: "Web Tools" },
        }),
      ])
    })
  },
}

// No matching row → the loading skeleton resolves to "not found".
export const NotFound: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
