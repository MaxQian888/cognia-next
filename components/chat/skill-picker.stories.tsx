import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillPicker } from "./skill-picker"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeSkill } from "@/lib/storybook/fixtures/skills"

// Multi-select command dialog for attaching skills to the next message. Reads
// the enabled, non-builtin (+ builtin) skills from Dexie, so the stories seed
// rows. Open by default to show the list.
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
  component: SkillPicker,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn(), value: [], onChange: fn() },
  beforeEach: seed,
} satisfies Meta<typeof SkillPicker>

export default meta
type Story = StoryObj<typeof meta>

/** Open with custom + builtin groups, nothing selected. */
export const Open: Story = {}

/** Two skills already selected — check marks shown. */
export const WithSelection: Story = {
  args: { value: ["sk-notes", "sk-search"] },
}

/** Closed — the dialog is not visible. */
export const Closed: Story = {
  args: { open: false },
}
