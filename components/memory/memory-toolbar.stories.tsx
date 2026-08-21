import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MemoryToolbar } from "./memory-toolbar"

// The single control band for `/memory`, normally rendered into the page
// header's `controls` slot. Quick views and Filter change which rows exist;
// Display changes their order and density.
const meta = {
  title: "Memory/MemoryToolbar",
  component: MemoryToolbar,
  args: {
    view: "all",
    onViewChange: fn(),
    viewCounts: { all: 42, pinned: 5, needsReview: 8, conflicts: 2, archived: 17 },
    filter: {},
    onFilterChange: fn(),
    facets: {
      types: [
        { value: "semantic", count: 24 },
        { value: "episodic", count: 12 },
        { value: "procedural", count: 6 },
      ],
      scopes: [
        { value: "global", count: 30 },
        { value: "workspace", count: 12 },
      ],
      provenances: [
        { value: "user", count: 20 },
        { value: "inbound", count: 22 },
      ],
      tags: [
        { value: "tools", count: 9 },
        { value: "preferences", count: 7 },
        { value: "team", count: 3 },
      ],
    },
    sort: "recent",
    onSortChange: fn(),
    density: "comfortable",
    onDensityChange: fn(),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="@container/feature-header w-full border-y bg-muted/16 px-4 py-1.5">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MemoryToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const ConflictsView: Story = {
  args: { view: "conflicts" },
}

/** The Filter trigger badges how many facet axes are narrowed. */
export const Filtered: Story = {
  args: { filter: { query: "pnpm", types: ["semantic"], tags: ["tools", "team"] } },
}

/** A view whose rows share every facet has nothing worth offering. */
export const NoFacets: Story = {
  args: {
    view: "conflicts",
    facets: { types: [], scopes: [], provenances: [], tags: [] },
  },
}
