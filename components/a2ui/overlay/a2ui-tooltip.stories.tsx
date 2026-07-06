import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UITooltip, type A2UITooltipComponent } from "./a2ui-tooltip"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { placeholderChild, withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const tooltip = (over: Partial<A2UITooltipComponent> = {}): A2UITooltipComponent => ({
  id: "tooltip",
  component: "Tooltip",
  text: "Saves the current surface to your workspace",
  children: ["tooltip-trigger"],
  ...over,
})

const renderChild = (id: string) => placeholderChild(id, "Hover for tooltip")

const meta = {
  title: "A2UI/Overlay/Tooltip",
  component: A2UITooltip,
  decorators: [withA2UISurface()],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UITooltip>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(tooltip(), { renderChild }),
}

export const BottomSide: Story = {
  args: makeA2UIProps(tooltip({ side: "bottom" }), { renderChild }),
}

export const FastOpen: Story = {
  args: makeA2UIProps(tooltip({ delayDuration: 0 }), { renderChild }),
}
