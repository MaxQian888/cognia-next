import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillCard } from "./skill-card"
import { makeSkill } from "@/lib/storybook/fixtures/mobile-discover"

// Skill row with an inline enable/disable Switch. Tapping the row opens the
// `MobileSkillSheet` (closed by default here). `onToggle` is supplied so the
// Switch never touches Dexie in Storybook.
const meta = {
  title: "Mobile/Discover/SkillCard",
  component: SkillCard,
  parameters: { layout: "padded" },
  args: { skill: makeSkill(), onToggle: fn() },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillCard>

export default meta
type Story = StoryObj<typeof meta>

export const Enabled: Story = {}

export const Disabled: Story = {
  args: { skill: makeSkill({ name: "Code review", status: "disabled" }) },
}

export const BuiltIn: Story = {
  args: { skill: makeSkill({ name: "Web research", isBuiltIn: true }) },
}

export const NoDescription: Story = {
  args: { skill: makeSkill({ name: "Terse skill", description: undefined }) },
}
