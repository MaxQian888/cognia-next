import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDetailConfigure } from "./plugin-detail-configure"
import { seedDb } from "@/lib/storybook/seed-db"
import { makePluginRow } from "@/lib/storybook/fixtures/plugins"

// Configure sub-tab — embeds the configSchema-driven form inline. Python /
// hybrid plugins additionally get the Python host settings card above the form.
// Reads the plugin row by id through a Dexie live query, so stories seed first.

const PLUGIN_ID = "com.acme.web-tools"

const meta = {
  title: "Plugins/Detail/PluginDetailConfigure",
  component: PluginDetailConfigure,
  args: { pluginId: PLUGIN_ID },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDetailConfigure>

export default meta
type Story = StoryObj<typeof meta>

// Frontend plugin with a string/number/boolean config schema → just the form.
export const FrontendForm: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([makePluginRow({ id: PLUGIN_ID, type: "frontend" })])
    })
  },
}

// Python plugin → the Python host settings card renders above the form.
export const PythonPlugin: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([
        makePluginRow({
          id: PLUGIN_ID,
          type: "python",
          manifest: {
            ...makePluginRow().manifest,
            pythonDependencies: ["pillow", "pytesseract"],
          },
        }),
      ])
    })
  },
}
