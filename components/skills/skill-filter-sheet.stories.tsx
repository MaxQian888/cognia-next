import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillFilterSheet } from "./skill-filter-sheet"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"

// Open state + active filters live in `useSkillsStore`. Seed it open; `allTags`
// (the tag dropdown options) comes from props.
const meta = {
  title: "Skills/SkillFilterSheet",
  component: SkillFilterSheet,
  parameters: { layout: "fullscreen" },
  args: { allTags: ["writing", "release", "ops", "research", "data"] },
  beforeEach: () => {
    resetStore(useSkillsStore)
    seedStore(useSkillsStore, { filterSheetOpen: true })
  },
} satisfies Meta<typeof SkillFilterSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const NoTags: Story = {
  args: { allTags: [] },
}
