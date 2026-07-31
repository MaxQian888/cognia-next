import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIDateTimePicker } from "./a2ui-datetimepicker"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UIDateTimePickerComponent } from "@/types/a2ui/schema"

const dateTimePicker = (
  over: Partial<A2UIDateTimePickerComponent> = {}
): A2UIDateTimePickerComponent => ({
  id: "datetime-picker",
  component: "DateTimePicker",
  value: "",
  label: "Reminder",
  ...over,
})

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/DateTimePicker",
  component: A2UIDateTimePicker,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIDateTimePicker>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  args: makeA2UIProps(dateTimePicker({ value: "" }), { onDataChange: fn() }),
}

export const Filled: Story = {
  args: makeA2UIProps(dateTimePicker({ value: "2026-06-29T14:30:00.000Z" }), {
    onDataChange: fn(),
  }),
}

export const Required: Story = {
  args: makeA2UIProps(dateTimePicker({ label: "Meeting start", value: "", required: true })),
}

export const WithMinMax: Story = {
  args: makeA2UIProps(
    dateTimePicker({
      label: "Slot",
      value: "2026-07-15T09:00:00.000Z",
      minDate: "2026-07-15T08:00:00.000Z",
      maxDate: "2026-07-15T18:00:00.000Z",
    })
  ),
}

export const Disabled: Story = {
  args: makeA2UIProps(dateTimePicker({ value: "2026-06-29T14:30:00.000Z", disabled: true })),
}
