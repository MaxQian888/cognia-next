import type { Meta, StoryObj } from "@storybook/nextjs"

import { PetRenderer } from "./pet-renderer"
import { makePetBones } from "@/lib/storybook/fixtures/pet-core"

// Public render entry: picks a skin and draws the given bones in a visual state.
// Defaults to the SVG mascot; the live2d skin degrades to SVG without a model.
const meta = {
  title: "Pet/Renderer",
  component: PetRenderer,
  parameters: { layout: "centered" },
  args: {
    bones: makePetBones(),
    stage: "adult",
    state: "idle",
    size: 160,
  },
  decorators: [
    (Story) => (
      <div className="flex h-[240px] w-[240px] items-center justify-center">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetRenderer>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {}

export const Egg: Story = {
  args: { stage: "egg" },
}

export const Happy: Story = {
  args: { state: "happy", oneShot: "petted" },
}

export const Sleeping: Story = {
  args: { state: "sleeping" },
}

export const Error: Story = {
  args: { state: "error" },
}

export const ReducedMotion: Story = {
  args: { reducedMotion: true, state: "happy" },
}

export const CommonDuck: Story = {
  args: {
    bones: makePetBones({
      species: "duck",
      rarity: "common",
      hat: "none",
      shiny: false,
      eyes: "dot",
      palette: { primary: "#ffd24a", secondary: "#fff0c2", accent: "#ff9f1c" },
    }),
  },
}
