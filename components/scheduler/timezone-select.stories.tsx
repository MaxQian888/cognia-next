import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TimezoneSelect } from "./timezone-select"

// `TimezoneSelect` is a pure controlled wrapper around the shadcn Select bound
// to the shared `TIMEZONE_OPTIONS` list. Stories cover the default value, a
// non-UTC value, the offset-suffix variant, and the disabled state.
const meta = {
  title: "Scheduler/TimezoneSelect",
  component: TimezoneSelect,
  parameters: { layout: "centered" },
  args: {
    onValueChange: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TimezoneSelect>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    value: "UTC",
  },
}

export const NonUtcValue: Story = {
  args: {
    value: "Asia/Shanghai",
  },
}

export const WithOffset: Story = {
  args: {
    value: "America/New_York",
    includeOffset: true,
  },
}

export const Disabled: Story = {
  args: {
    value: "Europe/London",
    disabled: true,
  },
}
