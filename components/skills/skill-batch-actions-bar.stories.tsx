import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillBatchActionsBar } from "./skill-batch-actions-bar"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"

// Store-reading: the floating bar appears only when `selection` is non-empty.
// `useLiveQuery(listSkillsByIds)` over the empty Storybook DB resolves to [].
const meta = {
  title: "Skills/SkillBatchActionsBar",
  component: SkillBatchActionsBar,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSkillsStore)
  },
} satisfies Meta<typeof SkillBatchActionsBar>

export default meta
type Story = StoryObj<typeof meta>

export const WithSelection: Story = {
  beforeEach: () => {
    resetStore(useSkillsStore)
    seedStore(useSkillsStore, { selection: new Set(["skill-1", "skill-2", "skill-3"]) })
  },
}

// Empty selection → the bar renders nothing.
export const NoSelection: Story = {}
