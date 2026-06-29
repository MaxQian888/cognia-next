import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIPopover, type A2UIPopoverComponent } from "./a2ui-popover"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { placeholderChild } from "@/lib/storybook/fixtures/a2ui-surface"

const popover = (over: Partial<A2UIPopoverComponent> = {}): A2UIPopoverComponent => ({
  id: "popover",
  component: "Popover",
  trigger: "popover-trigger",
  children: ["popover-body"],
  ...over,
})

const renderChild = (id: string) =>
  placeholderChild(id, id === "popover-trigger" ? "Open popover" : "Quick settings panel")

const meta = {
  title: "A2UI/Overlay/Popover",
  component: A2UIPopover,
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIPopover>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(popover(), { renderChild }),
}

export const AlignStart: Story = {
  args: makeA2UIProps(popover({ align: "start" }), { renderChild }),
}

export const RightSide: Story = {
  args: makeA2UIProps(popover({ side: "right" }), { renderChild }),
}
