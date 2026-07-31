import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIList } from "./a2ui-list"
import type { A2UIListComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const TASKS = [
  "Review pull request #482",
  "Sync connector credentials",
  "Approve Q2 budget",
  "Draft release notes for 2.9",
  "Triage incoming bug reports",
]

const list = (over: Partial<A2UIListComponent> = {}): A2UIListComponent => ({
  id: "list",
  component: "List",
  items: TASKS,
  ...over,
})

const meta = {
  title: "A2UI/Data/List",
  component: A2UIList,
  decorators: [withA2UISurface(), (Story) => <div className="w-80">{<Story />}</div>],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIList>

export default meta
type Story = StoryObj<typeof meta>

export const Bulleted: Story = { args: makeA2UIProps(list()) }

export const Ordered: Story = { args: makeA2UIProps(list({ ordered: true })) }

export const WithDividers: Story = { args: makeA2UIProps(list({ dividers: true })) }

export const Clickable: Story = {
  args: makeA2UIProps(list({ itemClickAction: "select-task", dividers: true })),
}

export const Empty: Story = {
  args: makeA2UIProps(list({ items: [], emptyText: "No tasks yet — you're all caught up." })),
}
