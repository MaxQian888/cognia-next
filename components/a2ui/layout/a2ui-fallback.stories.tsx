import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIFallback } from "./a2ui-fallback"
import type { A2UIBaseComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const fallback = (over: Partial<A2UIBaseComponent> = {}): A2UIBaseComponent => ({
  id: "fallback",
  component: "MysteryWidget",
  ...over,
})

const meta = {
  title: "A2UI/Layout/Fallback",
  component: A2UIFallback,
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIFallback>

export default meta
type Story = StoryObj<typeof meta>

export const UnknownComponent: Story = { args: makeA2UIProps(fallback()) }

export const TypoedComponent: Story = {
  args: makeA2UIProps(fallback({ id: "fallback-2", component: "Buton" })),
}
