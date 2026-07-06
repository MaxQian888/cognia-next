import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDetailPermissions } from "./plugin-detail-permissions"
import { seedDb } from "@/lib/storybook/seed-db"
import { makePluginRow } from "@/lib/storybook/fixtures/plugins"

// Permissions sub-tab — a table of every declared / optional / granted
// permission with its tier and grant/revoke actions, plus the per-plugin audit
// log. Permissions come from the manifest (seeded row) and grant decisions from
// `usePluginPermissions` (empty here, so all rows read "not granted"). Renders a
// "no permissions" note when the manifest declares none.

const PLUGIN_ID = "com.acme.web-tools"

const meta = {
  title: "Plugins/Detail/PluginDetailPermissions",
  component: PluginDetailPermissions,
  args: { pluginId: PLUGIN_ID },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDetailPermissions>

export default meta
type Story = StoryObj<typeof meta>

// Declared + optional permissions render in the table.
export const WithPermissions: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([
        makePluginRow({
          id: PLUGIN_ID,
          manifest: {
            ...makePluginRow().manifest,
            permissions: ["network:fetch", "filesystem:read", "shell:execute"],
            optionalPermissions: ["clipboard:read"],
          },
        }),
      ])
    })
  },
}

// Manifest with no permissions → the "no permissions" note.
export const NoPermissions: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([
        makePluginRow({ id: PLUGIN_ID, manifest: { id: PLUGIN_ID, name: "Web Tools" } }),
      ])
    })
  },
}

// No matching row.
export const NotFound: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
