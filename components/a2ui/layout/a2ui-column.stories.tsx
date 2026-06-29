import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIColumn } from "./a2ui-column"
import type { A2UIColumnComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { childStub, withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const column = (over: Partial<A2UIColumnComponent> = {}): A2UIColumnComponent => ({
  id: "column",
  component: "Column",
  children: ["a", "b", "c"],
  ...over,
})

const meta = {
  title: "A2UI/Layout/Column",
  component: A2UIColumn,
  decorators: [
    withA2UISurface({
      children: [
        childStub("a", "First row"),
        childStub("b", "Second row"),
        childStub("c", "Third row"),
      ],
    }),
  ],
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIColumn>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(column()) }

export const AlignCenter: Story = { args: makeA2UIProps(column({ align: "center" })) }

export const AlignEnd: Story = { args: makeA2UIProps(column({ align: "end" })) }

export const WideGap: Story = { args: makeA2UIProps(column({ gap: 24 })) }
