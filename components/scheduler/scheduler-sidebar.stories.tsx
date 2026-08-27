import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerSidebarContent } from "./scheduler-sidebar"
import { makeUnifiedItemSet } from "@/lib/storybook/fixtures/scheduler"
import { deriveUnifiedFacets } from "@/lib/scheduler/unified-filter"
import type { ScheduledItemKind } from "@/types/scheduler/unified"

// `SchedulerSidebarContent` is the provider-free content variant rendered inside
// the desktop resizable panel (the `<Sidebar>` chrome wrapper needs a
// SidebarProvider; the content sections do not). It is fully props-driven.
const meta = {
  title: "Scheduler/SchedulerSidebar",
  component: SchedulerSidebarContent,
  parameters: { layout: "fullscreen" },
  args: {
    schedulerStatus: "running",
    searchQuery: "",
    statusFilter: "all",
    selectedKinds: new Set<ScheduledItemKind>(),
    loopOnly: false,
    selectedUnifiedId: null,
    onSearchChange: fn(),
    onStatusFilterChange: fn(),
    onToggleKind: fn(),
    onLoopOnlyChange: fn(),
    onClearKindFilters: fn(),
    onResetFilters: fn(),
    onSelectItem: fn(),
    onRunNow: fn(),
    onPause: fn(),
    onResume: fn(),
    onDelete: fn(),
    onCreate: fn(),
  },
  decorators: [
    (Story) => (
      <div className="flex h-[760px] w-[320px] flex-col bg-sidebar text-sidebar-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SchedulerSidebarContent>

export default meta
type Story = StoryObj<typeof meta>

const unifiedItems = makeUnifiedItemSet()

/** The default view — every source merged and grouped by kind. */
export const Default: Story = {
  args: {
    items: unifiedItems,
    facets: deriveUnifiedFacets(unifiedItems),
    selectedUnifiedId: unifiedItems[0]?.unifiedId ?? null,
    selectedUnifiedIds: [],
    onToggleUnifiedSelection: fn(),
  },
}

/** A pinned kind — the footer reports how much is hidden and offers a reset. */
export const KindFiltered: Story = {
  args: {
    items: unifiedItems,
    selectedKinds: new Set<ScheduledItemKind>(["workflow"]),
    facets: deriveUnifiedFacets(unifiedItems, {
      kinds: new Set<ScheduledItemKind>(["workflow"]),
    }),
  },
}

/** A search that matches nothing — the filtered empty state with its reset CTA. */
export const NoMatches: Story = {
  args: {
    items: unifiedItems,
    searchQuery: "zzzz",
    facets: deriveUnifiedFacets(unifiedItems, { search: "zzzz" }),
  },
}

/** Stopped scheduler — the status dot turns red. */
export const Stopped: Story = {
  args: {
    items: unifiedItems,
    facets: deriveUnifiedFacets(unifiedItems),
    schedulerStatus: "stopped",
  },
}

/** No source has anything scheduled — the create CTA is shown. */
export const Empty: Story = {
  args: {
    items: [],
    facets: deriveUnifiedFacets([]),
  },
}

/**
 * A source that failed to load says so. Without this strip a source that threw
 * on subscribe was indistinguishable from a source with nothing scheduled —
 * the hook has always collected these errors and nothing rendered them.
 */
export const SourceLoadFailed: Story = {
  args: {
    items: unifiedItems,
    facets: deriveUnifiedFacets(unifiedItems),
    sourceErrors: {
      workflow: new Error("workflowTriggers is unavailable"),
      system: new Error("launchd refused the query"),
    },
  },
}
