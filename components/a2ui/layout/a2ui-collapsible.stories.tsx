import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UICollapsible, type A2UICollapsibleComponent } from "./a2ui-collapsible"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { placeholderChild, withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const collapsible = (over: Partial<A2UICollapsibleComponent> = {}): A2UICollapsibleComponent => ({
  id: "collapsible",
  component: "Collapsible",
  title: "Advanced options",
  children: ["opt-1", "opt-2"],
  ...over,
})

const meta = {
  title: "A2UI/Layout/Collapsible",
  component: A2UICollapsible,
  decorators: [withA2UISurface()],
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UICollapsible>

export default meta
type Story = StoryObj<typeof meta>

export const Collapsed: Story = {
  args: makeA2UIProps(collapsible(), { renderChild: placeholderChild }),
}

export const Open: Story = {
  args: makeA2UIProps(collapsible({ open: true }), { renderChild: placeholderChild }),
}
