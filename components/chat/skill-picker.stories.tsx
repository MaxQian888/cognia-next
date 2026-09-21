import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { Command } from "@/components/ui/command"
import { SkillPickerContent } from "./skill-picker"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeSkill } from "@/lib/storybook/fixtures/skills"

// The grouped skill list the composer's `+` menu flyout hosts. Reads the
// enabled, non-builtin (+ builtin) skills from Dexie, so the stories seed
// rows. Rendered inside a `Command` at the flyout's real width.
const CUSTOM = [
  makeSkill({ id: "sk-notes", name: "Release Notes", isBuiltIn: false, status: "enabled" }),
  makeSkill({ id: "sk-review", name: "Code Review", isBuiltIn: false, status: "enabled" }),
]
const BUILTIN = [
  makeSkill({ id: "sk-search", name: "Web Search", isBuiltIn: true, status: "enabled" }),
]

const seed = () =>
  seedDb(async (db) => {
    await db.skills.bulkPut([...CUSTOM, ...BUILTIN])
  })

const meta = {
  title: "Chat/SkillPicker",
  component: SkillPickerContent,
  parameters: { layout: "centered" },
  args: { active: true, value: [], onChange: fn() },
  beforeEach: seed,
  decorators: [
    (Story) => (
      <Command className="w-72 rounded-md border border-border">
        <Story />
      </Command>
    ),
  ],
} satisfies Meta<typeof SkillPickerContent>

export default meta
type Story = StoryObj<typeof meta>

/** Custom + builtin groups, nothing selected. */
export const Open: Story = {}

/** Two skills already selected — check marks shown. */
export const WithSelection: Story = {
  args: { value: ["sk-notes", "sk-search"] },
}

/** Inactive — the flyout is closed, so the list does not read the table. */
export const Inactive: Story = {
  args: { active: false },
}
