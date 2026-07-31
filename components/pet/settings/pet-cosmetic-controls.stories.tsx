import type { Meta, StoryObj } from "@storybook/nextjs"

import { PetCosmeticControls } from "./pet-cosmetic-controls"
import { seedDb } from "@/lib/storybook/seed-db"
import { makePetProfile } from "@/lib/storybook/fixtures/pet-core"

// In-app "Look" editor: restyle palette / hat / eyes / body without touching the
// pet's genetic identity. Reads the reactive `usePet` profile from Dexie and
// persists overrides via `patchPetProfile`, so it needs a hatched profile row.
const meta = {
  title: "Pet/Settings/CosmeticControls",
  component: PetCosmeticControls,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.petProfile.put(makePetProfile())
    })
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl rounded-xl border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetCosmeticControls>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithExistingOverride: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.petProfile.put(
        makePetProfile({ cosmetic: { hat: "wizard", eyes: "star", bodyType: "tall" } })
      )
    })
  },
}
