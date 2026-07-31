import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIInputOTP, type A2UIInputOTPComponent } from "./a2ui-input-otp"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const inputOtp = (over: Partial<A2UIInputOTPComponent> = {}): A2UIInputOTPComponent => ({
  id: "otp",
  component: "InputOTP",
  value: "",
  ...over,
})

// `A2UIInputOTP` reads its `value` through `useA2UIData()`, which needs an
// `A2UIProvider`. Literal values resolve directly without a seeded surface.
const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/InputOTP",
  component: A2UIInputOTP,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIInputOTP>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = { args: makeA2UIProps(inputOtp(), { onDataChange: fn() }) }

export const PartiallyFilled: Story = { args: makeA2UIProps(inputOtp({ value: "123" })) }

export const Complete: Story = { args: makeA2UIProps(inputOtp({ value: "123456" })) }

export const FourDigit: Story = {
  args: makeA2UIProps(inputOtp({ label: "PIN", maxLength: 4, value: "12" })),
}

export const WithLabel: Story = {
  args: makeA2UIProps(inputOtp({ label: "Verification code", value: "9087" })),
}

export const Disabled: Story = {
  args: makeA2UIProps(inputOtp({ label: "Locked", value: "111111", disabled: true })),
}
