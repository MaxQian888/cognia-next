import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIToggle } from "./a2ui-toggle"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UIToggleComponent } from "@/types/a2ui/schema"

const toggle = (over: Partial<A2UIToggleComponent> = {}): A2UIToggleComponent => ({
  id: "toggle",
  component: "Toggle",
  label: "Bold",
  ...over,
})

// `A2UIToggle` reads label/pressed/disabled through `useA2UIData()`, which needs
// an `A2UIProvider`. Literal values resolve directly without a seeded surface.
const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/Toggle",
  component: A2UIToggle,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIToggle>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(toggle()) }

export const Pressed: Story = { args: makeA2UIProps(toggle({ pressed: true })) }

export const Outline: Story = {
  args: makeA2UIProps(toggle({ label: "Italic", variant: "outline" })),
}

export const Small: Story = { args: makeA2UIProps(toggle({ label: "S", size: "sm" })) }

export const Large: Story = { args: makeA2UIProps(toggle({ label: "Underline", size: "lg" })) }

export const WithAction: Story = {
  args: makeA2UIProps(toggle({ label: "Mute", action: "toggleMute" }), {
    onAction: fn(),
    onDataChange: fn(),
  }),
}

export const Disabled: Story = {
  args: makeA2UIProps(toggle({ label: "Locked", pressed: true, disabled: true })),
}
