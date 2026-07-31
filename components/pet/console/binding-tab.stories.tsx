import type { Meta, StoryObj } from "@storybook/nextjs"

import { BindingTab } from "./binding-tab"
import { seedDb } from "@/lib/storybook/seed-db"

// Binding tab: per-character pet species overrides (cosmetic only). Characters +
// bindings are read reactively from Dexie. The built-in seed provides the
// starter characters, so the default story lists them with the species selector.
const meta = {
  title: "Pet/Console/BindingTab",
  component: BindingTab,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await seedDb(async () => {})
  },
} satisfies Meta<typeof BindingTab>

export default meta
type Story = StoryObj<typeof meta>

export const SeededCharacters: Story = {}

export const WithBinding: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      const first = await db.characters.toCollection().first()
      if (first) {
        await db.petCharacterBindings.put({
          characterId: first.id,
          species: "dragon",
          updatedAt: new Date().toISOString(),
        })
      }
    })
  },
}
