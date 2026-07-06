import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIComparisonCards } from "./a2ui-comparison-cards"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UIComparisonCardItem, A2UIComparisonCardsComponent } from "@/types/a2ui/schema"

const PLAN_ITEMS: A2UIComparisonCardItem[] = [
  {
    id: "free",
    title: "Free",
    description: "For trying things out",
    value: "$0",
    badge: "Current",
    footer: "Up to 3 projects",
  },
  {
    id: "pro",
    title: "Pro",
    description: "For growing teams",
    value: "$29/mo",
    badge: "Popular",
    footer: "Unlimited projects",
  },
]

const cards = (over: Partial<A2UIComparisonCardsComponent> = {}): A2UIComparisonCardsComponent => ({
  id: "comparison",
  component: "ComparisonCards",
  items: PLAN_ITEMS,
  ...over,
})

const meta = {
  title: "A2UI/Display/ComparisonCards",
  component: A2UIComparisonCards,
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIComparisonCards>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(cards()) }

export const WithHeading: Story = {
  args: makeA2UIProps(
    cards({
      title: "Choose a plan",
      description: "Switch or cancel anytime.",
    })
  ),
}

export const Clickable: Story = {
  args: makeA2UIProps(cards({ itemClickAction: "select-plan" }), { onAction: fn() }),
}

export const Empty: Story = {
  args: makeA2UIProps(cards({ items: [], emptyText: "No options to compare yet." })),
}

export const DataBound: Story = {
  args: makeA2UIProps(cards({ items: { path: "/plans" } }), {
    dataModel: {
      plans: [
        { id: "starter", title: "Starter", value: "$9/mo", footer: "Solo use" },
        { id: "team", title: "Team", value: "$49/mo", badge: "Best value", footer: "5 seats" },
      ] satisfies A2UIComparisonCardItem[],
    },
  }),
}
