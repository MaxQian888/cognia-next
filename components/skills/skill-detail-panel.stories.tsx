import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillDetailPanel } from "./skill-detail-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeSkill } from "@/lib/storybook/fixtures/skills"

// Mobile-only Sheet (gated by `useIsMobile`). It opens when `detailSkillId` is
// set and loads the row via `useLiveQuery(getSkill)`. At desktop widths the
// component renders null, so view this story at a mobile viewport width.
const SKILL_ID = "story-skill"

const meta = {
  title: "Skills/SkillDetailPanel",
  component: SkillDetailPanel,
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    resetStore(useSkillsStore)
    await seedDb(async (db) => {
      await db.skills.put(makeSkill({ id: SKILL_ID, name: "Release Notes Writer" }))
    })
    seedStore(useSkillsStore, { detailSkillId: SKILL_ID })
  },
} satisfies Meta<typeof SkillDetailPanel>

export default meta
type Story = StoryObj<typeof meta>

// Renders the open Sheet only at mobile widths; null on desktop.
export const MobileOpen: Story = {}
