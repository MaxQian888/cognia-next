import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIRow } from "./a2ui-row"
import type { A2UIRowComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { childStub, withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const row = (over: Partial<A2UIRowComponent> = {}): A2UIRowComponent => ({
  id: "row",
  component: "Row",
  children: ["a", "b", "c"],
  ...over,
})

const meta = {
  title: "A2UI/Layout/Row",
  component: A2UIRow,
  decorators: [
    withA2UISurface({
      children: [
        childStub("a", "Alpha"),
        childStub("b", "Beta"),
        childStub("c", "Gamma"),
        childStub("d", "Delta"),
        childStub("e", "Epsilon"),
        childStub("f", "Zeta"),
      ],
    }),
  ],
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIRow>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(row()) }

export const SpaceBetween: Story = { args: makeA2UIProps(row({ justify: "between" })) }

export const Centered: Story = { args: makeA2UIProps(row({ justify: "center", gap: 16 })) }

export const Wrapped: Story = {
  args: makeA2UIProps(row({ children: ["a", "b", "c", "d", "e", "f"], wrap: true, gap: 8 })),
}
