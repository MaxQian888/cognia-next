import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillResourceManager } from "./skill-resource-manager"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeSkillResource } from "@/lib/storybook/fixtures/skills"

// Dexie-backed: `useLiveQuery(listResourcesForSkill)` reads the
// `skillResources` table. Default renders the empty state; the seeded story
// inserts script/reference/asset rows.
const SKILL_ID = "skill-1"

const meta = {
  title: "Skills/SkillResourceManager",
  component: SkillResourceManager,
  parameters: { layout: "padded" },
  args: { skillId: SKILL_ID },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillResourceManager>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

export const WithResources: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.skillResources.bulkPut([
        makeSkillResource({
          skillId: SKILL_ID,
          kind: "script",
          name: "build.sh",
          path: "scripts/build.sh",
        }),
        makeSkillResource({
          skillId: SKILL_ID,
          kind: "reference",
          name: "api.md",
          path: "references/api.md",
          content: "# API\n\nReference notes.",
        }),
        makeSkillResource({
          skillId: SKILL_ID,
          kind: "asset",
          name: "logo.png",
          path: "assets/logo.png",
          encoding: "base64",
          mimeType: "image/png",
          content: "",
        }),
      ])
    })
  },
}
