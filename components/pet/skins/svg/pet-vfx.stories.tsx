import type { Meta, StoryObj } from "@storybook/nextjs"

import { PetVfx } from "./pet-vfx"

// Particle / VFX layer: rarity aura + motes, petted hearts, level-up sparkles, a
// shiny shimmer, and an error sweat-drop. Renders nothing under reduced motion.
// Lives in the 100×100 pet viewBox, so stories wrap it in a sized <svg>.
const meta = {
  title: "Pet/Skins/Vfx",
  component: PetVfx,
  parameters: { layout: "centered" },
  args: {
    state: "idle",
    oneShot: null,
    shiny: false,
    rarity: "legendary",
    reducedMotion: false,
  },
  decorators: [
    (Story) => (
      <svg viewBox="0 0 100 100" width={200} height={200} style={{ overflow: "visible" }}>
        <rect x={0} y={0} width={100} height={100} fill="#1f2430" rx={8} />
        <Story />
      </svg>
    ),
  ],
} satisfies Meta<typeof PetVfx>

export default meta
type Story = StoryObj<typeof meta>

export const LegendaryAura: Story = {}

export const ShinyShimmer: Story = {
  args: { shiny: true, rarity: "rare" },
}

export const PettedHearts: Story = {
  args: { oneShot: "petted" },
}

export const LevelUpSparkles: Story = {
  args: { oneShot: "levelUp" },
}

export const ErrorSweat: Story = {
  args: { state: "error", rarity: "common" },
}

export const ReducedMotion: Story = {
  args: { reducedMotion: true, oneShot: "levelUp", shiny: true },
}
