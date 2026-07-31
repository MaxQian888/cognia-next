import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginPermissionsTab } from "./plugin-permissions-tab"
import { seedDb } from "@/lib/storybook/seed-db"
import { makePluginRow, samplePluginRows } from "@/lib/storybook/fixtures/plugins"

// Cross-plugin permissions overview — splits installed plugins into a
// "dangerous permissions" bucket and a "normal" bucket, with a bulk-review
// entry point. Reads the installed set via `usePlugins` and grant decisions via
// `usePluginPermissions` (empty here). Seed the DB to populate the buckets.

const meta = {
  title: "Plugins/Detail/PluginPermissionsTab",
  component: PluginPermissionsTab,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[680px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginPermissionsTab>

export default meta
type Story = StoryObj<typeof meta>

// A library where one plugin requests dangerous permissions (shell/process).
export const WithDangerousPlugin: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([
        ...samplePluginRows(),
        makePluginRow({
          id: "com.acme.shell-runner",
          name: "Shell Runner",
          capabilities: ["tools"],
          manifest: {
            id: "com.acme.shell-runner",
            name: "Shell Runner",
            permissions: ["shell:execute", "process:spawn", "filesystem:write"],
          },
        }),
      ])
    })
  },
}

// No installed plugins → empty state.
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
