import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"

import { A2UIBadge } from "./a2ui-badge"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import type { A2UIBadgeComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const badge = (over: Partial<A2UIBadgeComponent> = {}): A2UIBadgeComponent => ({
  id: "badge",
  component: "Badge",
  text: "New",
  ...over,
})

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Display/Badge",
  component: A2UIBadge,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(badge()) }

export const Secondary: Story = {
  args: makeA2UIProps(badge({ text: "Beta", variant: "secondary" })),
}

export const Destructive: Story = {
  args: makeA2UIProps(badge({ text: "Deprecated", variant: "destructive" })),
}

export const Outline: Story = {
  args: makeA2UIProps(badge({ text: "Draft", variant: "outline" })),
}

export const LongText: Story = {
  args: makeA2UIProps(badge({ text: "Limited time offer", variant: "secondary" })),
}
