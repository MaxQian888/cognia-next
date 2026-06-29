import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DiscoverGrid } from "./discover-grid"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

// Shared item grid (grid / list / compact). Renders the items it's handed and
// dispatches selection back via `onSelectItem`. Reads `useDiscoverFavorites`
// (settings store) for the star state. Loading + empty branches are first-class.
const item = (raw: { kind: string; id: string; data: Record<string, unknown> }): DiscoverItem =>
  raw as unknown as DiscoverItem

const characters: DiscoverItem[] = [
  item({
    kind: "character",
    id: "c1",
    data: { name: "Ada", description: "Senior engineer persona.", avatarEmoji: "🧠" },
  }),
  item({
    kind: "character",
    id: "c2",
    data: { name: "Bryn", description: "Friendly support agent.", avatarEmoji: "💬" },
  }),
  item({
    kind: "character",
    id: "c3",
    data: { name: "Cole", description: "Terse code reviewer.", avatarEmoji: "🔍" },
  }),
]

const meta = {
  title: "Discover/DiscoverGrid",
  component: DiscoverGrid,
  args: {
    category: "characters",
    items: characters,
    loading: false,
    query: "",
    selectedItemId: null,
    onSelectItem: fn(),
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[560px] flex-col">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiscoverGrid>

export default meta
type Story = StoryObj<typeof meta>

export const GridView: Story = {}

export const ListView: Story = { args: { view: "list" } }

export const CompactView: Story = { args: { view: "compact" } }

export const Loading: Story = { args: { loading: true, items: [] } }

export const Empty: Story = { args: { items: [] } }

export const EmptyFiltered: Story = { args: { items: [], query: "nonexistent" } }
