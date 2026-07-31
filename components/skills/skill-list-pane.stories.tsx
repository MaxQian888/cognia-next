import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillListPane } from "./skill-list-pane"
import { makeSkill } from "@/lib/storybook/fixtures/skills"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"

const skills = [
  makeSkill({ name: "Release Notes Writer", category: "productivity" }),
  makeSkill({ name: "API Reviewer", category: "development", status: "disabled" }),
  makeSkill({ name: "Data Profiler", category: "data-analysis", source: "builtin" }),
  makeSkill({ name: "Standup Summarizer", category: "communication" }),
]

// Takes the filtered rows + counts as props, but reads the active filter and
// selection from `useSkillsStore`. Reset the store between renders.
const meta = {
  title: "Skills/SkillListPane",
  component: SkillListPane,
  parameters: { layout: "fullscreen" },
  args: {
    skills,
    total: skills.length,
    enabledCount: 3,
    countsBySource: { builtin: 1, custom: 3 },
    countsByCategory: { productivity: 1, development: 1, "data-analysis": 1, communication: 1 },
    onCreate: fn(),
  },
  beforeEach: () => {
    resetStore(useSkillsStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[600px] w-[360px] border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillListPane>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Empty: Story = {
  args: { skills: [], total: 0, enabledCount: 0 },
}
