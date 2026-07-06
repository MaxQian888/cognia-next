import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIAccordion } from "./a2ui-accordion"
import type { A2UIAccordionComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { childStub, withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const accordion = (over: Partial<A2UIAccordionComponent> = {}): A2UIAccordionComponent => ({
  id: "accordion",
  component: "Accordion",
  items: [
    { id: "shipping", title: "Shipping & delivery", children: ["shipping-body"] },
    { id: "returns", title: "Returns policy", children: ["returns-body"] },
    { id: "support", title: "Contact support", children: ["support-body"] },
  ],
  ...over,
})

const meta = {
  title: "A2UI/Layout/Accordion",
  component: A2UIAccordion,
  decorators: [
    withA2UISurface({
      children: [
        childStub("shipping-body", "Orders ship within 2 business days via tracked courier."),
        childStub("returns-body", "Unused items can be returned within 30 days for a full refund."),
        childStub("support-body", "Reach the team at support@cognia.example, 9-5 PT."),
      ],
    }),
  ],
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIAccordion>

export default meta
type Story = StoryObj<typeof meta>

export const Single: Story = { args: makeA2UIProps(accordion()) }

export const Multiple: Story = { args: makeA2UIProps(accordion({ multiple: true })) }

export const WithDefaultOpen: Story = {
  args: makeA2UIProps(
    accordion({
      items: [
        {
          id: "shipping",
          title: "Shipping & delivery",
          children: ["shipping-body"],
          defaultOpen: true,
        },
        { id: "returns", title: "Returns policy", children: ["returns-body"] },
        { id: "support", title: "Contact support", children: ["support-body"] },
      ],
    })
  ),
}
