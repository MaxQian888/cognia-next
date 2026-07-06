import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDetailEmpty } from "./plugin-detail-empty"
import { seedDb } from "@/lib/storybook/seed-db"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"

// Idle state for the detail pane (no plugin selected). Reuses the shared Empty
// scaffold and surfaces a summary of the installed set (total / enabled /
// updates / errored) read from `usePlugins` (a Dexie live query). The summary
// badges only show when their count is non-zero.

const meta = {
  title: "Plugins/Detail/PluginDetailEmpty",
  component: PluginDetailEmpty,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[480px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDetailEmpty>

export default meta
type Story = StoryObj<typeof meta>

// No installed plugins — only the total/enabled badges (both 0) render.
export const EmptyLibrary: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

// A seeded library exercises the full badge row, including the destructive
// "errored" badge (the OCR sample is in an error state).
export const WithInstalledPlugins: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
    })
  },
}
