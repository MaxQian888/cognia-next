import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIDrawer, type A2UIDrawerComponent } from "./a2ui-drawer"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { placeholderChild, withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const drawer = (over: Partial<A2UIDrawerComponent> = {}): A2UIDrawerComponent => ({
  id: "drawer",
  component: "Drawer",
  trigger: "drawer-trigger",
  title: "Filters",
  description: "Refine the results shown in the table.",
  children: ["drawer-body"],
  ...over,
})

const renderChild = (id: string) =>
  placeholderChild(id, id === "drawer-trigger" ? "Open drawer" : "Filter controls")

const meta = {
  title: "A2UI/Navigation/Drawer",
  component: A2UIDrawer,
  decorators: [withA2UISurface()],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIDrawer>

export default meta
type Story = StoryObj<typeof meta>

export const ClosedWithTrigger: Story = {
  args: makeA2UIProps(drawer(), { renderChild }),
}

export const Open: Story = {
  args: makeA2UIProps(drawer({ open: true }), { renderChild }),
}
