import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetAppearanceControls } from "./pet-appearance-controls"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"

// Appearance controls (dock anchor, motion, skin, widget size) over the shared
// `{ pet, patch }` interface. SVG skin keeps the Live2D model manager hidden.
const meta = {
  title: "Pet/Settings/AppearanceControls",
  component: PetAppearanceControls,
  parameters: { layout: "padded" },
  args: { pet: { ...DEFAULT_PET_SETTINGS }, patch: fn() },
  decorators: [
    (Story) => (
      <div className="max-w-md space-y-4 rounded-xl border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetAppearanceControls>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const TopLeftReducedMotion: Story = {
  args: {
    pet: { ...DEFAULT_PET_SETTINGS, anchor: "top-left", motion: "reduced", size: 128 },
  },
}
