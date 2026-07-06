import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UICheckbox } from "./a2ui-checkbox"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UICheckboxComponent } from "@/types/a2ui/schema"

const checkbox = (over: Partial<A2UICheckboxComponent> = {}): A2UICheckboxComponent => ({
  id: "checkbox",
  component: "Checkbox",
  checked: false,
  label: "Accept terms and conditions",
  ...over,
})

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/Checkbox",
  component: A2UICheckbox,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UICheckbox>

export default meta
type Story = StoryObj<typeof meta>

export const Unchecked: Story = {
  args: makeA2UIProps(checkbox(), { onDataChange: fn() }),
}

export const Checked: Story = {
  args: makeA2UIProps(checkbox({ checked: true }), { onDataChange: fn() }),
}

export const WithHelperText: Story = {
  args: makeA2UIProps(
    checkbox({
      label: "Subscribe to newsletter",
      helperText: "We send at most one email per week.",
    })
  ),
}

export const NoLabel: Story = {
  args: makeA2UIProps(checkbox({ label: undefined })),
}

export const Disabled: Story = {
  args: makeA2UIProps(checkbox({ label: "Locked option", checked: true, disabled: true })),
}
