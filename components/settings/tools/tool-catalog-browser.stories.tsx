import type { Meta, StoryObj } from "@storybook/nextjs"

import { ToolCatalogBrowser } from "./tool-catalog-browser"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Unified tool/MCP search + filter browser. Aggregates the tool catalog via
// `getToolCatalog()` (the built-in tools resolve in the browser) and reads the
// persisted `toolFilter` from the settings store. In "all" mode the checkboxes
// are disabled (nothing to filter); switching to allow/deny enables selection.
const meta = {
  title: "Settings/Tools/ToolCatalogBrowser",
  component: ToolCatalogBrowser,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({ toolFilter: { mode: "all" } }),
    })
  },
} satisfies Meta<typeof ToolCatalogBrowser>

export default meta
type Story = StoryObj<typeof meta>

// "All" mode: every catalogued tool listed, checkboxes disabled.
export const AllMode: Story = {}

// Allow-list mode with a couple of tools pre-selected — checkboxes active.
export const AllowList: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({
        toolFilter: { mode: "allow", tools: ["read_file", "list_directory"] },
      }),
    })
  },
}
