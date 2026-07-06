import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillListItem } from "./skill-list-item"
import { makeSkill, makeValidationError } from "@/lib/storybook/fixtures/skills"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills/skills-store"

// Mostly props-driven; reads `updateAvailable[id]` from the store for the
// "update available" badge, so reset the store between renders.
const meta = {
  title: "Skills/SkillListItem",
  component: SkillListItem,
  parameters: { layout: "padded" },
  args: {
    skill: makeSkill({ name: "Release Notes Writer" }),
    selected: false,
    active: false,
    onToggleSelect: fn(),
    onOpen: fn(),
  },
  beforeEach: () => {
    resetStore(useSkillsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillListItem>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Active: Story = {
  args: { active: true },
}

export const Selected: Story = {
  args: { selected: true },
}

export const Disabled: Story = {
  args: { skill: makeSkill({ name: "Archived Skill", status: "disabled" }) },
}

export const WithValidationErrors: Story = {
  args: {
    skill: makeSkill({
      name: "Broken Skill",
      validationErrors: [makeValidationError(), makeValidationError({ code: "missing-content" })],
    }),
  },
}
