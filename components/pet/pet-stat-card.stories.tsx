import type { Meta, StoryObj } from "@storybook/nextjs"

import { PetStatCard } from "./pet-stat-card"
import { makePetBones, makePetSoul } from "@/lib/storybook/fixtures/pet-core"

// The pet's identity card: live preview + rarity ring, stars, shiny badge, the
// five flavour stats (with earned-growth overfill), and the hatched name.
const meta = {
  title: "Pet/StatCard",
  component: PetStatCard,
  parameters: { layout: "padded" },
  args: {
    bones: makePetBones(),
    soul: makePetSoul(),
    stage: "adult",
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetStatCard>

export default meta
type Story = StoryObj<typeof meta>

export const LegendaryShiny: Story = {}

export const Common: Story = {
  args: {
    bones: makePetBones({
      species: "duck",
      rarity: "common",
      stars: 1,
      hat: "none",
      shiny: false,
      eyes: "dot",
      palette: { primary: "#9aa0a6", secondary: "#cfd3d6", accent: "#f5c542" },
      stats: { debugging: 40, patience: 55, chaos: 20, wisdom: 35, snark: 60 },
    }),
    soul: makePetSoul({ name: "Quack" }),
  },
}

export const WithEarnedGrowth: Story = {
  args: {
    progress: { debugging: 6, patience: 0, chaos: 0, wisdom: 4, snark: 0 },
    grew: ["debugging", "wisdom"],
  },
}

export const Unhatched: Story = {
  args: {
    bones: makePetBones({ shiny: false, rarity: "uncommon", stars: 2 }),
    soul: null,
    stage: "egg",
  },
}
