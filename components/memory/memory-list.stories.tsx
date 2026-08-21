import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MemoryList } from "./memory-list"
import { makeMemorySet } from "@/lib/storybook/fixtures/memory"

// The virtualized list — the only content `/memory` has, so it gets the whole
// center pane. Loading, empty, and filtered-empty are three distinct states.
const meta = {
  title: "Memory/MemoryList",
  component: MemoryList,
  args: {
    rows: makeMemorySet(),
    isLoading: false,
    hasAnyMemories: true,
    selectedIds: new Set<string>(),
    selectionActive: true,
    onOpenDetail: fn(),
    onSelectToggle: fn(),
    onPinToggle: fn(),
    onSave: fn(),
    onArchive: fn(),
    onDelete: fn(),
    onTagClick: fn(),
    onClearFilters: fn(),
    onAddFirst: fn(),
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[680px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MemoryList>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Compact: Story = {
  args: { density: "compact" },
}

/** Never collapsed into the empty state — that would flash a CTA every visit. */
export const Loading: Story = {
  args: { isLoading: true, rows: [] },
}

export const Empty: Story = {
  args: { rows: [], hasAnyMemories: false },
}

/** Someone with 300 memories should be offered a reset, not "add your first". */
export const FilteredEmpty: Story = {
  args: { rows: [], hasAnyMemories: true },
}
