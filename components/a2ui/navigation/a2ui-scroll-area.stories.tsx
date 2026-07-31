import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIScrollArea, type A2UIScrollAreaComponent } from "./a2ui-scroll-area"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { placeholderChild } from "@/lib/storybook/fixtures/a2ui-surface"

const CHILD_IDS = Array.from({ length: 12 }, (_, i) => `item-${i + 1}`)

const scrollArea = (over: Partial<A2UIScrollAreaComponent> = {}): A2UIScrollAreaComponent => ({
  id: "scroll-area",
  component: "ScrollArea",
  children: CHILD_IDS,
  height: 200,
  ...over,
})

const renderChild = (id: string) => placeholderChild(id, `Row ${id.replace("item-", "")}`)

const meta = {
  title: "A2UI/Navigation/ScrollArea",
  component: A2UIScrollArea,
  decorators: [(Story) => <div className="w-72">{<Story />}</div>],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIScrollArea>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(scrollArea(), { renderChild }),
}

export const Tall: Story = {
  args: makeA2UIProps(scrollArea({ height: 320 }), { renderChild }),
}
