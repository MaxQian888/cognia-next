import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillCategoryButtonList } from "./skill-category-sidebar"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"

// Takes count props but reads/writes the active filter through `useSkillsStore`.
// Reset the store each render; the "filtered" story seeds an active category.
const meta = {
  title: "Skills/SkillCategorySidebar",
  component: SkillCategoryButtonList,
  parameters: { layout: "padded" },
  args: {
    total: 24,
    countsByCategory: {
      development: 8,
      productivity: 6,
      "data-analysis": 4,
      communication: 3,
      custom: 3,
    },
    countsBySource: { builtin: 10, custom: 8, imported: 4, marketplace: 2 },
    onSelect: fn(),
  },
  beforeEach: () => {
    resetStore(useSkillsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-[240px] rounded-md border p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillCategoryButtonList>

export default meta
type Story = StoryObj<typeof meta>

export const AllSelected: Story = {}

export const CategoryFiltered: Story = {
  beforeEach: () => {
    resetStore(useSkillsStore)
    seedStore(useSkillsStore, {
      filters: { ...useSkillsStore.getState().filters, category: "development", source: "all" },
    })
  },
}
