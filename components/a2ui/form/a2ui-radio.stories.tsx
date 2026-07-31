import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIRadio, A2UIRadioGroup } from "./a2ui-radio"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UIRadioComponent, A2UIRadioGroupComponent } from "@/types/a2ui/schema"

const group = (over: Partial<A2UIRadioGroupComponent> = {}): A2UIRadioGroupComponent => ({
  id: "radio-group",
  component: "RadioGroup",
  value: "",
  label: "Notification preference",
  options: [
    { value: "email", label: "Email" },
    { value: "sms", label: "SMS" },
    { value: "push", label: "Push notification" },
  ],
  ...over,
})

const radio = (over: Partial<A2UIRadioComponent> = {}): A2UIRadioComponent => ({
  id: "radio",
  component: "Radio",
  value: "email",
  label: "Email",
  ...over,
})

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

// Meta targets the options-bearing RadioGroup (the primary form control); the
// single Radio renderer is exercised via dedicated `render` stories below.
const meta = {
  title: "A2UI/Form/Radio",
  component: A2UIRadioGroup,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIRadioGroup>

export default meta
type Story = StoryObj<typeof meta>

export const GroupDefault: Story = {
  args: makeA2UIProps(group(), { onDataChange: fn() }),
}

export const GroupSelected: Story = {
  args: makeA2UIProps(group({ value: "sms" }), { onDataChange: fn() }),
}

export const GroupHorizontal: Story = {
  args: makeA2UIProps(group({ value: "email", orientation: "horizontal" })),
}

export const GroupWithDisabledOption: Story = {
  args: makeA2UIProps(
    group({
      value: "email",
      options: [
        { value: "email", label: "Email" },
        { value: "sms", label: "SMS (unavailable)", disabled: true },
        { value: "push", label: "Push notification" },
      ],
    })
  ),
}

export const GroupDisabled: Story = {
  args: makeA2UIProps(group({ value: "push", disabled: true })),
}

// Single-Radio stories render the standalone Radio renderer; `args` is required
// by the RadioGroup-typed meta but intentionally unused by the custom `render`.
export const SingleUnchecked: Story = {
  args: makeA2UIProps(group()),
  render: () => <A2UIRadio {...makeA2UIProps(radio({ checked: false }), { onDataChange: fn() })} />,
}

export const SingleChecked: Story = {
  args: makeA2UIProps(group()),
  render: () => <A2UIRadio {...makeA2UIProps(radio({ checked: true }), { onDataChange: fn() })} />,
}

export const SingleDisabled: Story = {
  args: makeA2UIProps(group()),
  render: () => (
    <A2UIRadio {...makeA2UIProps(radio({ label: "Locked", checked: true, disabled: true }))} />
  ),
}
