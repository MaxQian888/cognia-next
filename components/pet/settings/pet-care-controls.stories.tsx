import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetCareControls } from "./pet-care-controls"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"

// Care + performance controls: low-power rendering and the unwell care alert.
// Pure props over the shared `{ pet, patch }` interface.
const meta = {
  title: "Pet/Settings/CareControls",
  component: PetCareControls,
  parameters: { layout: "padded" },
  args: { pet: { ...DEFAULT_PET_SETTINGS }, patch: fn() },
  decorators: [
    (Story) => (
      <div className="max-w-md space-y-4 rounded-xl border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetCareControls>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const LowPowerOnAlertsOff: Story = {
  args: { pet: { ...DEFAULT_PET_SETTINGS, lowPower: true, careAlerts: false } },
}
