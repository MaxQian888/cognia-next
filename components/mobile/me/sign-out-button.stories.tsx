import type { Meta, StoryObj } from "@storybook/nextjs"

import { SignOutButton } from "./sign-out-button"

// Destructive sign-out trigger. Opens a confirm AlertDialog; the actual sign-out
// is gated behind `useCompanionSignOut` (biometric prompt + credential/pairing
// wipe), which no-ops in the Storybook browser.
const meta = {
  title: "Mobile/Me/SignOutButton",
  component: SignOutButton,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SignOutButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
