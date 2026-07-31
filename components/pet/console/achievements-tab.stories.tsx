import type { Meta, StoryObj } from "@storybook/nextjs"

import { AchievementsTab } from "./achievements-tab"
import { seedDb } from "@/lib/storybook/seed-db"

// Achievements tab: every achievement rendered locked/unlocked. The unlocked set
// is read reactively from Dexie via `useLiveQuery`.
const meta = {
  title: "Pet/Console/AchievementsTab",
  component: AchievementsTab,
  parameters: { layout: "padded" },
} satisfies Meta<typeof AchievementsTab>

export default meta
type Story = StoryObj<typeof meta>

// Empty DB → every achievement renders in its locked (greyed) state.
export const AllLocked: Story = {}

// Seed a few unlocked records so the unlocked (coloured) styling shows.
export const SomeUnlocked: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      const now = Date.now()
      await db.petAchievements.bulkPut([
        { id: "hatched", unlockedAt: now - 86_400_000 },
        { id: "first-xp", unlockedAt: now - 43_200_000 },
        { id: "juvenile", unlockedAt: now - 3_600_000 },
      ])
    })
  },
}
