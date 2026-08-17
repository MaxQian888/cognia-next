import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginSectionToolbar } from "../plugin-section-toolbar"
import { useLibrarySubFilterSegments } from "./plugin-library-sub-filter"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// Library's status axis (all / enabled / updates / configurable / errored)
// as it actually ships: segments in the shared section toolbar, not a chip
// row of its own. Badge counts come from `usePlugins()`; the active segment
// is derived from `filters`. Seed the DB so the counts are non-zero —
// `visibleSegments` hides any segment sitting at 0, which is exactly what
// the Empty story below demonstrates.
function LibrarySegmentsHarness() {
  return <PluginSectionToolbar segments={useLibrarySubFilterSegments()} />
}

const meta = {
  title: "Plugins/Library/LibraryStatusSegments",
  component: LibrarySegmentsHarness,
  parameters: { layout: "padded" },
} satisfies Meta<typeof LibrarySegmentsHarness>

export default meta
type Story = StoryObj<typeof meta>

export const WithCounts: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
    })
    return () => resetStore(usePluginsStore)
  },
}

// Empty library → every count is 0, so only the active "all" segment
// survives the zero-count rule.
export const Empty: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    await seedDb(async () => {})
  },
}
