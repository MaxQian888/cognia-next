import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UICard } from "./a2ui-card"
import type { A2UICardComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { childStub, withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const card = (over: Partial<A2UICardComponent> = {}): A2UICardComponent => ({
  id: "card",
  component: "Card",
  ...over,
})

const meta = {
  title: "A2UI/Layout/Card",
  component: A2UICard,
  decorators: [
    withA2UISurface({
      children: [
        childStub("body", "The pipeline shipped 14 features this sprint with zero rollbacks."),
        childStub("footer-cancel", "Dismiss"),
        childStub("footer-confirm", "View report"),
      ],
    }),
  ],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UICard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(
    card({ title: "Quarterly report", description: "Engineering velocity, Q2 2026" })
  ),
}

export const WithImage: Story = {
  args: makeA2UIProps(
    card({
      title: "Release 2.9",
      description: "Desktop + mobile parity",
      image: "https://picsum.photos/seed/cognia/640/360",
    })
  ),
}

export const WithChildren: Story = {
  args: makeA2UIProps(
    card({ title: "Sprint summary", description: "Auto-generated", children: ["body"] })
  ),
}

export const WithFooter: Story = {
  args: makeA2UIProps(
    card({
      title: "Confirm deployment",
      description: "This will promote build #482 to production.",
      children: ["body"],
      footer: ["footer-cancel", "footer-confirm"],
    })
  ),
}

export const Clickable: Story = {
  args: makeA2UIProps(
    card({
      title: "Open dashboard",
      description: "Click anywhere on this card",
      clickAction: "open",
    })
  ),
}

export const Disabled: Story = {
  args: makeA2UIProps(
    card({
      title: "Locked card",
      description: "Click is disabled",
      clickAction: "open",
      disabled: true,
    })
  ),
}
