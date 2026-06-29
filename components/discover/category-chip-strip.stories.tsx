import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CategoryChipStrip } from "./category-chip-strip"
import { FAVORITES_CATEGORY } from "@/lib/discover/categories"

// Mobile category chip strip. Consumes `useDiscoverLayout` for the visible set
// + order (favorites first, then pinned, then overflow) and centers the active
// chip. With no persisted layout it renders the default category set.
const meta = {
  title: "Discover/CategoryChipStrip",
  component: CategoryChipStrip,
  args: { activeCategory: FAVORITES_CATEGORY, onSelect: fn() },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="w-[420px] py-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CategoryChipStrip>

export default meta
type Story = StoryObj<typeof meta>

export const FavoritesActive: Story = {}

export const CharactersActive: Story = { args: { activeCategory: "characters" } }
