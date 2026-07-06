import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UISwitch, type A2UISwitchComponent } from "./a2ui-switch"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const toggle = (over: Partial<A2UISwitchComponent> = {}): A2UISwitchComponent => ({
  id: "switch",
  component: "Switch",
  checked: false,
  label: "Enable notifications",
  ...over,
})

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/Switch",
  component: A2UISwitch,
  decorators: [withA2UI],
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UISwitch>

export default meta
type Story = StoryObj<typeof meta>

export const Off: Story = {
  args: makeA2UIProps(toggle(), { onDataChange: fn() }),
}

export const On: Story = {
  args: makeA2UIProps(toggle({ checked: true }), { onDataChange: fn() }),
}

export const WithDescription: Story = {
  args: makeA2UIProps(
    toggle({
      label: "Dark mode",
      description: "Use a darker color scheme across the app.",
      checked: true,
    })
  ),
}

export const NoLabel: Story = {
  args: makeA2UIProps(toggle({ label: undefined, checked: true })),
}

export const Disabled: Story = {
  args: makeA2UIProps(toggle({ label: "Managed by admin", checked: true, disabled: true })),
}
