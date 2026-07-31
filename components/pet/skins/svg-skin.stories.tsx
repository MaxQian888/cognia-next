import type { Meta, StoryObj } from "@storybook/nextjs"

import { svgSkin } from "./svg-skin"
import type { PetSkinRenderProps } from "@/types/pet"
import { makePetBones } from "@/lib/storybook/fixtures/pet-core"

// The default SVG skin is exported as a `PetSkin` object, not a component. This
// thin wrapper renders `svgSkin.render(props)` so the composed body + face + VFX
// <svg> can be previewed across states/locomotion.
function SvgSkin(props: PetSkinRenderProps) {
  return <>{svgSkin.render(props)}</>
}

const meta = {
  title: "Pet/Skins/SvgSkin",
  component: SvgSkin,
  parameters: { layout: "centered" },
  args: {
    bones: makePetBones(),
    stage: "adult",
    state: "idle",
    oneShot: null,
    reducedMotion: false,
    size: 180,
  },
  decorators: [
    (Story) => (
      <div className="flex h-[260px] w-[260px] items-center justify-center">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SvgSkin>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {}

export const Egg: Story = { args: { stage: "egg" } }

export const Thinking: Story = { args: { state: "thinking" } }

export const WalkingLeft: Story = {
  args: { locomotion: { mode: "walking", facing: "left" } },
}

export const Paused: Story = { args: { paused: true, state: "happy" } }
