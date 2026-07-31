import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIHoverCard, type A2UIHoverCardComponent } from "./a2ui-hover-card"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { placeholderChild } from "@/lib/storybook/fixtures/a2ui-surface"

const hoverCard = (over: Partial<A2UIHoverCardComponent> = {}): A2UIHoverCardComponent => ({
  id: "hover-card",
  component: "HoverCard",
  trigger: "hover-trigger",
  children: ["hover-body"],
  ...over,
})

const renderChild = (id: string) =>
  placeholderChild(
    id,
    id === "hover-trigger" ? "Hover over me" : "Joined March 2024 · 142 contributions"
  )

const meta = {
  title: "A2UI/Overlay/HoverCard",
  component: A2UIHoverCard,
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIHoverCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(hoverCard(), { renderChild }),
}

export const RightSide: Story = {
  args: makeA2UIProps(hoverCard({ side: "right", align: "start" }), { renderChild }),
}

export const FastOpen: Story = {
  args: makeA2UIProps(hoverCard({ openDelay: 0 }), { renderChild }),
}
