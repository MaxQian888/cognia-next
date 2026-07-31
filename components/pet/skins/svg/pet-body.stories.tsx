import type { Meta, StoryObj } from "@storybook/nextjs"

import { PetBody } from "./pet-body"
import { makePetBones } from "@/lib/storybook/fixtures/pet-core"

// The parametric body silhouette: one component draws every species from its
// traits (ears/tail/face) + the bones palette/body type. Lives in the 100×100
// pet viewBox, so stories wrap it in a sized <svg>.
const meta = {
  title: "Pet/Skins/Body",
  component: PetBody,
  parameters: { layout: "centered" },
  args: { bones: makePetBones() },
  decorators: [
    (Story) => (
      <svg viewBox="0 0 100 100" width={180} height={180} style={{ overflow: "visible" }}>
        <Story />
      </svg>
    ),
  ],
} satisfies Meta<typeof PetBody>

export default meta
type Story = StoryObj<typeof meta>

export const Cat: Story = {}

export const Rabbit: Story = {
  args: { bones: makePetBones({ species: "rabbit", hat: "none", bodyType: "tall" }) },
}

export const RobotWide: Story = {
  args: {
    bones: makePetBones({
      species: "robot",
      hat: "none",
      bodyType: "wide",
      palette: { primary: "#7cc4ff", secondary: "#d6ecff", accent: "#2a6df0" },
    }),
  },
}

export const Dragon: Story = {
  args: { bones: makePetBones({ species: "dragon", hat: "wizard" }) },
}

export const Penguin: Story = {
  args: { bones: makePetBones({ species: "penguin", hat: "tophat" }) },
}
