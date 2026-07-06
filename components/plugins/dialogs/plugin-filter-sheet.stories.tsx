import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginFilterSheet } from "./plugin-filter-sheet"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { usePluginsStore } from "@/stores/plugins"

// Library filter drawer (query, capability, source, status, permission). It is
// a controlled Sheet whose open state and filter values live in the plugins
// store, so the story seeds `filterSheetOpen` to reveal it.

const meta = {
  title: "Plugins/Dialogs/PluginFilterSheet",
  component: PluginFilterSheet,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PluginFilterSheet>

export default meta
type Story = StoryObj<typeof meta>

// Open with default filters.
export const Open: Story = {
  beforeEach: () => {
    seedStore(usePluginsStore, { filterSheetOpen: true })
    return () => resetStore(usePluginsStore)
  },
}

// Open with some active filters applied.
export const WithActiveFilters: Story = {
  beforeEach: () => {
    seedStore(usePluginsStore, {
      filterSheetOpen: true,
      filters: {
        ...usePluginsStore.getState().filters,
        query: "web",
        capability: "tools",
      },
    })
    return () => resetStore(usePluginsStore)
  },
}
