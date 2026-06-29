import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIDivider } from "./a2ui-divider"
import type { A2UIDividerComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const divider = (over: Partial<A2UIDividerComponent> = {}): A2UIDividerComponent => ({
  id: "divider",
  component: "Divider",
  ...over,
})

const meta = {
  title: "A2UI/Layout/Divider",
  component: A2UIDivider,
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIDivider>

export default meta
type Story = StoryObj<typeof meta>

export const Horizontal: Story = {
  args: makeA2UIProps(divider()),
  decorators: [(Story) => <div className="w-80">{<Story />}</div>],
}

export const WithText: Story = {
  args: makeA2UIProps(divider({ text: "OR" })),
  decorators: [(Story) => <div className="w-80">{<Story />}</div>],
}

export const Vertical: Story = {
  args: makeA2UIProps(divider({ orientation: "vertical" })),
  decorators: [(Story) => <div className="flex h-24 items-center">{<Story />}</div>],
}
