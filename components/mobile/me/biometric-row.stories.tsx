import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { BiometricRow } from "./biometric-row"

// Props-only labelled Switch row used by the biometric / notification settings.
const meta = {
  title: "Mobile/Me/BiometricRow",
  component: BiometricRow,
  parameters: { layout: "padded" },
  args: {
    label: "Require Face ID to sign out",
    help: "Confirm with biometrics before clearing the pairing.",
    checked: false,
    onChange: fn(),
    testid: "biometric-row",
  },
  decorators: [
    (Story) => (
      <div className="w-[360px] rounded-xl border bg-card px-3">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BiometricRow>

export default meta
type Story = StoryObj<typeof meta>

export const Off: Story = {}

export const On: Story = {
  args: { checked: true },
}
