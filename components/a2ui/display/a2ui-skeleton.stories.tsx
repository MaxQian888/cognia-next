import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UISkeleton, type A2UISkeletonComponent } from "./a2ui-skeleton"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const skeleton = (over: Partial<A2UISkeletonComponent> = {}): A2UISkeletonComponent => ({
  id: "skeleton",
  component: "Skeleton",
  ...over,
})

const meta = {
  title: "A2UI/Display/Skeleton",
  component: A2UISkeleton,
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UISkeleton>

export default meta
type Story = StoryObj<typeof meta>

export const SingleLine: Story = {
  args: makeA2UIProps(skeleton({ variant: "text", width: 240 })),
}

export const MultilineText: Story = {
  args: makeA2UIProps(skeleton({ variant: "text", lines: 4 })),
}

export const Circular: Story = {
  args: makeA2UIProps(skeleton({ variant: "circular" })),
}

export const Rectangular: Story = {
  args: makeA2UIProps(skeleton({ variant: "rectangular", width: 320, height: 160 })),
}
