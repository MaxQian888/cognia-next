import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillAnalytics } from "./skill-analytics"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"

// Propless dashboard — `useSkillAnalytics` aggregates over the (empty in
// Storybook) Dexie skills table, so charts render with zeroed series.
const meta = {
  title: "Skills/SkillAnalytics",
  component: SkillAnalytics,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSkillsStore)
  },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] w-full flex-col border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillAnalytics>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
