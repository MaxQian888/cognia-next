import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginLibraryViewToggle } from "./plugin-library-view-toggle"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { usePluginsStore } from "@/stores/plugins"

// Grid/list view switch for the library. Reads and writes `listViewMode` on the
// plugins store, so each story seeds the desired mode.

const meta = {
  title: "Plugins/Library/PluginLibraryViewToggle",
  component: PluginLibraryViewToggle,
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginLibraryViewToggle>

export default meta
type Story = StoryObj<typeof meta>

export const CardSelected: Story = {
  beforeEach: () => {
    seedStore(usePluginsStore, { listViewMode: "card" })
    return () => resetStore(usePluginsStore)
  },
}

export const ListSelected: Story = {
  beforeEach: () => {
    seedStore(usePluginsStore, { listViewMode: "list" })
    return () => resetStore(usePluginsStore)
  },
}
