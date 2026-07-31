import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIDatePicker } from "./a2ui-datepicker"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UIDatePickerComponent } from "@/types/a2ui/schema"

const datePicker = (over: Partial<A2UIDatePickerComponent> = {}): A2UIDatePickerComponent => ({
  id: "date-picker",
  component: "DatePicker",
  value: "",
  label: "Start date",
  ...over,
})

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/DatePicker",
  component: A2UIDatePicker,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIDatePicker>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  args: makeA2UIProps(datePicker({ value: "", placeholder: "Choose a date" }), {
    onDataChange: fn(),
  }),
}

export const Filled: Story = {
  args: makeA2UIProps(datePicker({ value: "2026-06-29" }), { onDataChange: fn() }),
}

export const Required: Story = {
  args: makeA2UIProps(datePicker({ label: "Due date", value: "", required: true })),
}

export const WithMinMax: Story = {
  args: makeA2UIProps(
    datePicker({
      label: "Booking date",
      value: "2026-07-15",
      minDate: "2026-07-01",
      maxDate: "2026-07-31",
    })
  ),
}

export const NoLabel: Story = {
  args: makeA2UIProps(datePicker({ label: undefined, placeholder: "Pick a date" })),
}

export const Disabled: Story = {
  args: makeA2UIProps(datePicker({ value: "2026-06-29", disabled: true })),
}
