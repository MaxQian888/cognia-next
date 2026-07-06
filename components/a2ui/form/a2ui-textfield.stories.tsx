import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UITextField } from "./a2ui-textfield"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UITextFieldComponent } from "@/types/a2ui/schema"

const textField = (over: Partial<A2UITextFieldComponent> = {}): A2UITextFieldComponent => ({
  id: "text-field",
  component: "TextField",
  value: "",
  label: "Full name",
  ...over,
})

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/TextField",
  component: A2UITextField,
  decorators: [withA2UI],
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UITextField>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  args: makeA2UIProps(textField({ value: "", placeholder: "Jane Doe" }), { onDataChange: fn() }),
}

export const Filled: Story = {
  args: makeA2UIProps(textField({ value: "Ada Lovelace" }), { onDataChange: fn() }),
}

export const WithHelperText: Story = {
  args: makeA2UIProps(
    textField({
      label: "Username",
      placeholder: "yourname",
      helperText: "This is how you'll appear to others.",
    })
  ),
}

export const Email: Story = {
  args: makeA2UIProps(
    textField({
      label: "Email",
      type: "email",
      value: "ada@example.com",
      placeholder: "you@example.com",
    })
  ),
}

export const Password: Story = {
  args: makeA2UIProps(textField({ label: "Password", type: "password", value: "hunter2" })),
}

export const Required: Story = {
  args: makeA2UIProps(textField({ label: "Workspace name", value: "", required: true })),
}

export const Error: Story = {
  args: makeA2UIProps(
    textField({
      label: "Email",
      type: "email",
      value: "not-an-email",
      error: "Enter a valid email address.",
    })
  ),
}

export const Disabled: Story = {
  args: makeA2UIProps(textField({ value: "system@cognia.app", disabled: true })),
}
