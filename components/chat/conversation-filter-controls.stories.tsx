import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import {
  ConversationFilterChips,
  ConversationFilterMenu,
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
  applyPreset: fn(),
  savePreset: fn(() => "id"),
  renamePreset: fn(),
  deletePreset: fn(),
}

const presets = [
  {
    id: "p1",
    name: "Unread team chats",
    filters: { unread: true, kind: "team" as const },
    createdAt: 1,
  },
  { id: "p2", name: "This week", filters: { activity: "week" as const }, createdAt: 2 },
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
  options,
  presets: [],
  activePreset: undefined,
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
      presets,
    },
  },
}

export const MenuWithActivePreset: Story = {
  args: {
    model: {
      ...base,
      activeFilters: 2,
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, kind: "team" },
      presets,
      activePreset: presets[0],
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

/** List facets collapse to one chip each; a matching preset replaces the breakdown. */
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

export const ChipsPreset: Story = {
  args: {
    model: {
      ...base,
      activeFilters: 2,
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, kind: "team" },
      presets,
      activePreset: presets[0],
    },
  },
  render: (args) => (
    <div className="w-72 rounded-md border p-2">
      <ConversationFilterChips {...args} shown={6} total={118} />
    </div>
  ),
}
