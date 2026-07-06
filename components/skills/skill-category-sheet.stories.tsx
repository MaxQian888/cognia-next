import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillCategorySheet } from "./skill-category-sheet"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"

// Mobile Sheet whose open state lives in `useSkillsStore.categorySheetOpen`.
// Seed it open so the sheet renders; counts come from props.
const meta = {
  title: "Skills/SkillCategorySheet",
  component: SkillCategorySheet,
  parameters: { layout: "fullscreen" },
  args: {
    total: 24,
    countsByCategory: { development: 8, productivity: 6, "data-analysis": 4, custom: 6 },
    countsBySource: { builtin: 10, custom: 8, imported: 4, marketplace: 2 },
  },
  beforeEach: () => {
    resetStore(useSkillsStore)
    seedStore(useSkillsStore, { categorySheetOpen: true })
  },
} satisfies Meta<typeof SkillCategorySheet>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}
