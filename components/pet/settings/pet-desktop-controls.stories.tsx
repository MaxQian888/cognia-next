import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetDesktopControls } from "./pet-desktop-controls"
import { DEFAULT_PET_SETTINGS, DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_WANDER } from "@/types/pet"

// Desktop overlay ("desktop pet") controls — normally Tauri-only. Pure render
// over `{ pet, patch }`; the window side-effects only fire on toggle. Enabling
// the overlay reveals the wander sub-block.
const meta = {
  title: "Pet/Settings/DesktopControls",
  component: PetDesktopControls,
  parameters: { layout: "padded" },
  args: { pet: { ...DEFAULT_PET_SETTINGS }, patch: fn() },
  decorators: [
    (Story) => (
      <div className="max-w-md space-y-4 rounded-xl border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetDesktopControls>

export default meta
type Story = StoryObj<typeof meta>

export const Disabled: Story = {}

export const EnabledWithWander: Story = {
  args: {
    pet: {
      ...DEFAULT_PET_SETTINGS,
      desktopPet: {
        ...DEFAULT_PET_DESKTOP_OVERLAY,
        enabled: true,
        size: 160,
        wander: { ...DEFAULT_PET_WANDER, enabled: true, frequency: "lively", range: "near" },
      },
    },
  },
}
