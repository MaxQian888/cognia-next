import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DiscoverCategorySidebar } from "./discover-category-sidebar"
import { FAVORITES_CATEGORY } from "@/lib/discover/categories"

// Left rail accordion of category super-groups from `useDiscoverLayout`, with a
// pinned Favorites pseudo-category and a Customize dialog trigger. Renders the
// default layout when nothing is persisted.
const meta = {
  title: "Discover/DiscoverCategorySidebar",
  component: DiscoverCategorySidebar,
  args: { activeCategory: FAVORITES_CATEGORY, onSelect: fn() },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[560px] w-64 flex-col border-r">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiscoverCategorySidebar>

export default meta
type Story = StoryObj<typeof meta>

export const FavoritesActive: Story = {}

export const CharactersActive: Story = { args: { activeCategory: "characters" } }
