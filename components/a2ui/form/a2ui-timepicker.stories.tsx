import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UITimePicker } from "./a2ui-timepicker"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UITimePickerComponent } from "@/types/a2ui/schema"

const timePicker = (over: Partial<A2UITimePickerComponent> = {}): A2UITimePickerComponent => ({
  id: "time",
  component: "TimePicker",
  value: "",
  ...over,
})

// `A2UITimePicker` reads its value through `useA2UIData()`, which requires an
// `A2UIProvider`. The preview only wires intl/theme/tooltip/router, so wrap the
// story in a provider; literal `value`s resolve directly (no seeded surface).
const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/TimePicker",
  component: A2UITimePicker,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UITimePicker>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = { args: makeA2UIProps(timePicker(), { onDataChange: fn() }) }

export const WithValue: Story = {
  args: makeA2UIProps(timePicker({ value: "09:30" }), { onDataChange: fn() }),
}

export const WithLabel: Story = {
  args: makeA2UIProps(timePicker({ label: "Meeting time", value: "14:00" })),
}

export const Required: Story = {
  args: makeA2UIProps(timePicker({ label: "Start time", required: true })),
}

export const Placeholder: Story = {
  args: makeA2UIProps(timePicker({ label: "Reminder", placeholder: "Pick a time" })),
}

export const Disabled: Story = {
  args: makeA2UIProps(timePicker({ label: "Locked slot", value: "12:00", disabled: true })),
}
