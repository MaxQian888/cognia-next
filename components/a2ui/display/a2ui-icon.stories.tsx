import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIIcon } from "./a2ui-icon"
import type { A2UIIconComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const icon = (over: Partial<A2UIIconComponent> = {}): A2UIIconComponent => ({
  id: "icon",
  component: "Icon",
  name: "sparkles",
  ...over,
})

const meta = {
  title: "A2UI/Display/Icon",
  component: A2UIIcon,
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIIcon>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(icon()) }

export const Star: Story = { args: makeA2UIProps(icon({ name: "star" })) }

export const Heart: Story = { args: makeA2UIProps(icon({ name: "heart" })) }

export const Settings: Story = { args: makeA2UIProps(icon({ name: "settings" })) }

export const KebabCaseName: Story = {
  args: makeA2UIProps(icon({ name: "check-circle" })),
}

export const Large: Story = {
  args: makeA2UIProps(icon({ name: "rocket", size: 64 })),
}

export const Colored: Story = {
  args: makeA2UIProps(icon({ name: "bell", color: "#f59e0b", size: 40 })),
}

export const UnknownNameFallback: Story = {
  args: makeA2UIProps(icon({ name: "this-icon-does-not-exist" })),
}
