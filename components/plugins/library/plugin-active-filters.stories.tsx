import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginActiveFilters } from "./plugin-active-filters"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { usePluginsStore } from "@/stores/plugins"

// Active-filter chip row — renders a removable chip per non-default filter plus
// a "clear all" affordance. Reads/writes the plugins store. With default filters
// it renders nothing; the stories seed active filters to show the chips.

const meta = {
  title: "Plugins/Library/PluginActiveFilters",
  component: PluginActiveFilters,
  parameters: { layout: "padded" },
} satisfies Meta<typeof PluginActiveFilters>

export default meta
type Story = StoryObj<typeof meta>

export const SeveralActive: Story = {
  beforeEach: () => {
    seedStore(usePluginsStore, {
      filters: {
        ...usePluginsStore.getState().filters,
        query: "web",
        capability: "tools",
      },
      librarySubFilter: "enabled",
    })
    return () => resetStore(usePluginsStore)
  },
}
