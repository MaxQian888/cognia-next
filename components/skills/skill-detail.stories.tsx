import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillDetail } from "./skill-detail"
import { makeSkill, makeValidationError } from "@/lib/storybook/fixtures/skills"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"

// Reads several `useSkillsStore` actions plus `useLiveQuery` over the (empty in
// Storybook) skill-resources table. Reset the store between renders.
const meta = {
  title: "Skills/SkillDetail",
  component: SkillDetail,
  parameters: { layout: "fullscreen" },
  args: { skill: makeSkill({ name: "Release Notes Writer" }) },
  beforeEach: () => {
    resetStore(useSkillsStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillDetail>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Disabled: Story = {
  args: { skill: makeSkill({ name: "Archived Skill", status: "disabled" }) },
}

export const BuiltInWithTags: Story = {
  args: {
    skill: makeSkill({
      name: "Built-in Researcher",
      source: "builtin",
      isBuiltIn: true,
      tags: ["research", "web", "writing"],
    }),
  },
}

export const WithValidationErrors: Story = {
  args: {
    skill: makeSkill({
      name: "Broken Skill",
      validationErrors: [makeValidationError(), makeValidationError({ code: "missing-content" })],
    }),
  },
}
