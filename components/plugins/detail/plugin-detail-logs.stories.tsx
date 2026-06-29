import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDetailLogs } from "./plugin-detail-logs"
import { seedDb } from "@/lib/storybook/seed-db"
import { makePluginRow } from "@/lib/storybook/fixtures/plugins"

// Logs sub-tab (python / hybrid plugins). Streams the per-plugin python host
// log buffer via `useSyncExternalStore` and shows a runtime-info strip from the
// Tauri host. In this plain-browser Storybook there is no host and no buffered
// logs, so the panel paints its empty state with the disabled "Clear" button —
// that's the chrome these stories cover.

const PLUGIN_ID = "com.acme.ocr"

const meta = {
  title: "Plugins/Detail/PluginDetailLogs",
  component: PluginDetailLogs,
  args: { pluginId: PLUGIN_ID },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDetailLogs>

export default meta
type Story = StoryObj<typeof meta>

// No buffered logs and no host runtime → the empty-state card.
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([makePluginRow({ id: PLUGIN_ID, type: "python" })])
    })
  },
}
