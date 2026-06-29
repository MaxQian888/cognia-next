import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillChipRow } from "./skill-chip-row"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeSkill } from "@/lib/storybook/fixtures/skills"

// Chip strip above the composer for ephemeral skills attached to the next send.
// Each chip is hydrated from the Dexie `skills` table, so the stories seed rows
// whose ids match `ids`. A session-disabled skill renders inert (struck-through).
const SK1 = makeSkill({ id: "chip-1", name: "Release Notes" })
const SK2 = makeSkill({ id: "chip-2", name: "Code Review" })
const SK3 = makeSkill({ id: "chip-3", name: "Translate" })

const seed = () =>
  seedDb(async (db) => {
    await db.skills.bulkPut([SK1, SK2, SK3])
  })

const meta = {
  title: "Chat/Composer/SkillChipRow",
  component: SkillChipRow,
  parameters: { layout: "padded" },
  args: { ids: ["chip-1", "chip-2"], onRemove: fn() },
  beforeEach: seed,
} satisfies Meta<typeof SkillChipRow>

export default meta
type Story = StoryObj<typeof meta>

/** Two attached skills, both active and removable. */
export const TwoSkills: Story = {}

/** One attached skill is disabled for the session → inert chip. */
export const WithInertSkill: Story = {
  args: { ids: ["chip-1", "chip-2"], disabledIds: ["chip-2"] },
}

/** Empty id list renders nothing. */
export const NoSkills: Story = {
  args: { ids: [] },
}
