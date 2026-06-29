import type { Meta, StoryObj } from "@storybook/nextjs"

import { PasswordStrengthMeter } from "./password-strength-meter"

// Visual-only password strength bar. It scores the password 0–4 and recolours
// the shared Progress indicator; an empty password renders nothing.
const meta = {
  title: "Account/PasswordStrengthMeter",
  component: PasswordStrengthMeter,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PasswordStrengthMeter>

export default meta
type Story = StoryObj<typeof meta>

export const Weak: Story = {
  args: { password: "abc" },
}

export const Medium: Story = {
  args: { password: "Tr0ub4dor" },
}

export const Strong: Story = {
  args: { password: "C0rrect-Horse-Battery-Staple!" },
}

// Empty password → the meter renders nothing.
export const EmptyHidden: Story = {
  args: { password: "" },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <PasswordStrengthMeter {...args} />
    </div>
  ),
}
