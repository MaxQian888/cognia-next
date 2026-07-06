import type { Meta, StoryObj } from "@storybook/nextjs"
import * as React from "react"

import { A2UICarousel, type A2UICarouselComponent } from "./a2ui-carousel"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { placeholderChild } from "@/lib/storybook/fixtures/a2ui-surface"

const carousel = (over: Partial<A2UICarouselComponent> = {}): A2UICarouselComponent => ({
  id: "carousel",
  component: "Carousel",
  children: ["slide-1", "slide-2", "slide-3"],
  ...over,
})

const renderChild = (id: string) => placeholderChild(id, `Slide ${id.replace("slide-", "")}`)

const meta = {
  title: "A2UI/Navigation/Carousel",
  component: A2UICarousel,
  decorators: [
    (Story: React.ComponentType) => <div className="mx-auto w-64 py-2">{<Story />}</div>,
  ],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UICarousel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(carousel(), { renderChild }),
}

export const Looping: Story = {
  args: makeA2UIProps(carousel({ loop: true }), { renderChild }),
}

export const NoControls: Story = {
  args: makeA2UIProps(carousel({ showControls: false }), { renderChild }),
}
