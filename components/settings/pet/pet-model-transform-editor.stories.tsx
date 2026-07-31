import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetModelTransformEditor } from "./pet-model-transform-editor"
import { DEFAULT_LIVE2D_TRANSFORM } from "@/types/pet"

// Pure, props-only: scale + X/Y offset slider/number pairs. The parent dialog
// owns the draft, so `onChange` is a spy here and stories vary `value`.
const meta = {
  title: "Settings/Pet/PetModelTransformEditor",
  component: PetModelTransformEditor,
  parameters: { layout: "padded" },
  args: {
    value: DEFAULT_LIVE2D_TRANSFORM,
    onChange: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetModelTransformEditor>

export default meta
type Story = StoryObj<typeof meta>

// Neutral transform — scale 1, no offset.
export const Default: Story = {}

// Zoomed in past the fit scale.
export const ScaledUp: Story = {
  args: { value: { scale: 1.6, offsetX: 0, offsetY: 0 } },
}

// Nudged toward a corner (offsets are fractions of the canvas size).
export const Offset: Story = {
  args: { value: { scale: 1.1, offsetX: -0.25, offsetY: 0.2 } },
}
