import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIPagination, type A2UIPaginationComponent } from "./a2ui-pagination"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const pagination = (over: Partial<A2UIPaginationComponent> = {}): A2UIPaginationComponent => ({
  id: "pagination",
  component: "Pagination",
  currentPage: 3,
  totalPages: 10,
  pageChangeAction: "go-to-page",
  ...over,
})

const meta = {
  title: "A2UI/Navigation/Pagination",
  component: A2UIPagination,
  decorators: [withA2UISurface()],
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIPagination>

export default meta
type Story = StoryObj<typeof meta>

export const Middle: Story = { args: makeA2UIProps(pagination()) }

export const FirstPage: Story = { args: makeA2UIProps(pagination({ currentPage: 1 })) }

export const LastPage: Story = {
  args: makeA2UIProps(pagination({ currentPage: 10, totalPages: 10 })),
}

export const WideRange: Story = {
  args: makeA2UIProps(pagination({ currentPage: 12, totalPages: 25, siblingCount: 2 })),
}
