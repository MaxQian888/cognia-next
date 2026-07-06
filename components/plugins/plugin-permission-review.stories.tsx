import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginPermissionReview } from "./plugin-permission-review"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makePluginRow } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// Permission review dialog, opened by `usePluginsStore.permissionReviewTarget`.
// Loads the target plugin's manifest from Dexie and lets the user grant/revoke
// declared + optional permissions. Renders nothing when no target is set.

const PLUGIN_ID = "com.acme.web-tools"

const meta = {
  title: "Plugins/PluginPermissionReview",
  component: PluginPermissionReview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PluginPermissionReview>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    await seedDb(async (db) => {
      await db.plugins.bulkPut([
        makePluginRow({
          id: PLUGIN_ID,
          manifest: {
            ...makePluginRow().manifest,
            permissions: ["network:fetch", "shell:execute"],
            optionalPermissions: ["clipboard:read"],
          },
        }),
      ])
    })
    seedStore(usePluginsStore, { permissionReviewTarget: { pluginId: PLUGIN_ID } })
    return () => resetStore(usePluginsStore)
  },
}
