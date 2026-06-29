import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetSoundControls } from "./pet-sound-controls"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"

// Sound controls: enable synthesized SFX, set volume, and a quiet-hours window.
// Pure props over the shared `{ pet, patch }` interface.
const meta = {
  title: "Pet/Settings/SoundControls",
  component: PetSoundControls,
  parameters: { layout: "padded" },
  args: { pet: { ...DEFAULT_PET_SETTINGS }, patch: fn() },
  decorators: [
    (Story) => (
      <div className="max-w-md space-y-4 rounded-xl border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetSoundControls>

export default meta
type Story = StoryObj<typeof meta>

export const Disabled: Story = {}

export const EnabledWithQuietHours: Story = {
  args: {
    pet: {
      ...DEFAULT_PET_SETTINGS,
      sound: { enabled: true, volume: 0.7, quietHours: { start: 22, end: 7 } },
    },
  },
}
