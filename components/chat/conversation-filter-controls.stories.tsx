import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import {
  ConversationFilterChips,
  ConversationFilterMenu,
  ConversationSearchScopeControl,
  type ConversationFilterViewModel,
} from "./conversation-filter-controls"
import { EMPTY_CONVERSATION_FILTER_OPTIONS } from "@/lib/chat/conversation-filter-options"
import {
  CONVERSATION_FILTER_UNASSIGNED,
  EMPTY_CONVERSATION_FILTERS,
} from "@/lib/chat/conversation-filters"

// Sort + filter controls shared by the desktop sidebar and the mobile channel
// list. The menu opens beside the trigger with hover submenus per facet (a
// bottom drawer on mobile); the chip row keeps the state visible and one click
// from gone, which is what makes persisting filters across reloads safe.

const actions: ConversationFilterViewModel["actions"] = {
  toggle: fn(),
  setKind: fn(),
  setList: fn(),
  toggleValue: fn(),
  setActivity: fn(),
  reset: fn(),
  setSortBy: fn(),
  setGroupBy: fn(),
  setSearchOptions: fn(),
  applyView: fn(),
  clearView: fn(),
  revertView: fn(),
  saveView: fn(() => "id"),
  updateView: fn(),
  renameView: fn(),
  removeView: fn(),
  restoreView: fn(),
}

const views: ConversationFilterViewModel["views"] = [
  {
    id: "p1",
    name: "Unread team chats",
    builtIn: false,
    createdAt: 1,
    overlay: {
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, kind: "team" },
      sortBy: "unread",
    },
  },
  {
    id: "p2",
    name: "This week",
    builtIn: false,
    createdAt: 2,
    overlay: { filters: { ...EMPTY_CONVERSATION_FILTERS, activity: "week" } },
  },
]

const options = {
  ...EMPTY_CONVERSATION_FILTER_OPTIONS,
  workspaceIds: [
    { value: "w1", label: "Alpha", count: 12 },
    { value: "w2", label: "Beta", count: 4 },
    { value: CONVERSATION_FILTER_UNASSIGNED, label: null, count: 3 },
  ],
  folderIds: [{ value: "f1", label: "Research", count: 5 }],
  agentIds: [
    { value: "c1", label: "Alice", count: 9 },
    { value: "c2", label: "Bob", count: 3 },
  ],
  teamIds: [{ value: "t1", label: "Squad", count: 2 }],
  models: [
    { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", count: 14 },
    { value: "gpt-5", label: "GPT-5", count: 5 },
  ],
  providers: [
    { value: "anthropic", label: "Anthropic", count: 14 },
    { value: "openai", label: "OpenAI", count: 5 },
  ],
}

const base: ConversationFilterViewModel = {
  filters: EMPTY_CONVERSATION_FILTERS,
  activeFilters: 0,
  sortBy: "recent",
  groupBy: "workspace",
  search: { workspace: "current", includeArchived: false, content: false },
  options,
  views: [],
  activeView: undefined,
  activeViewDrift: [],
  hiddenViewIds: [],
  suggestedViewDimensions: [],
  scopeOwnsKind: false,
  actions,
}

const meta = {
  title: "Chat/ConversationFilterControls",
  component: ConversationFilterMenu,
  parameters: { layout: "padded" },
  args: { model: base },
} satisfies Meta<typeof ConversationFilterMenu>

export default meta
type Story = StoryObj<typeof meta>

export const Menu: Story = {}

export const MenuWithActiveFilters: Story = {
  args: {
    model: {
      ...base,
      activeFilters: 3,
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, kind: "team", workspaceIds: ["w1"] },
      views,
      suggestedViewDimensions: ["filters"],
    },
  },
}

export const MenuWithActiveView: Story = {
  args: {
    model: {
      ...base,
      activeFilters: 2,
      sortBy: "unread",
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, kind: "team" },
      views,
      activeView: views[0],
    },
  },
}

/** The view is on, but the user has nudged its sort — the way back is offered. */
export const MenuWithModifiedView: Story = {
  args: {
    model: {
      ...base,
      activeFilters: 2,
      sortBy: "title",
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, kind: "team" },
      views,
      activeView: views[0],
      activeViewDrift: ["sortBy"],
      suggestedViewDimensions: ["filters", "sortBy"],
    },
  },
}

/** Nothing narrowing the list → the chip row renders nothing at all. */
export const ChipsHidden: Story = {
  render: (args) => (
    <div className="w-72 rounded-md border p-2">
      <ConversationFilterChips {...args} shown={12} total={12} />
    </div>
  ),
}

export const Chips: Story = {
  args: {
    model: {
      ...base,
      activeFilters: 2,
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, pinned: true },
    },
  },
  render: (args) => (
    <div className="w-72 rounded-md border p-2">
      <ConversationFilterChips {...args} shown={3} total={41} />
    </div>
  ),
}

/** A non-default sort is chipped too — "why is my newest chat at the bottom". */
export const ChipsSortOnly: Story = {
  args: { model: { ...base, sortBy: "title" } },
  render: (args) => (
    <div className="w-72 rounded-md border p-2">
      <ConversationFilterChips {...args} shown={41} total={41} />
    </div>
  ),
}

/** List facets collapse to one chip each. */
export const ChipsEverything: Story = {
  args: {
    model: {
      ...base,
      sortBy: "unread",
      activeFilters: 4,
      filters: {
        ...EMPTY_CONVERSATION_FILTERS,
        unread: true,
        kind: "dm",
        workspaceIds: ["w1", "w2", CONVERSATION_FILTER_UNASSIGNED],
        activity: "month",
      },
    },
  },
  render: (args) => (
    <div className="w-72 rounded-md border p-2">
      <ConversationFilterChips {...args} shown={2} total={118} />
    </div>
  ),
}

/** Inside a view, its name replaces the facet-by-facet breakdown. */
export const ChipsView: Story = {
  args: {
    model: {
      ...base,
      activeFilters: 2,
      sortBy: "unread",
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, kind: "team" },
      views,
      activeView: views[0],
    },
  },
  render: (args) => (
    <div className="w-72 rounded-md border p-2">
      <ConversationFilterChips {...args} shown={6} total={118} />
    </div>
  ),
}

/** Nudged out of the view: the chip says so, and its body puts the view back. */
export const ChipsViewModified: Story = {
  args: {
    model: {
      ...base,
      activeFilters: 1,
      sortBy: "title",
      filters: { ...EMPTY_CONVERSATION_FILTERS, pinned: true },
      views,
      activeView: views[0],
      activeViewDrift: ["filters", "sortBy"],
    },
  },
  render: (args) => (
    <div className="w-72 rounded-md border p-2">
      <ConversationFilterChips {...args} shown={9} total={118} />
    </div>
  ),
}

/** The search-reach control: three axes that used to live in three places. */
export const SearchScope: Story = {
  args: { model: { ...base, search: { workspace: "all", includeArchived: true, content: true } } },
  render: (args) => (
    <div className="w-72 rounded-md border p-2">
      <ConversationSearchScopeControl model={args.model} />
    </div>
  ),
}
