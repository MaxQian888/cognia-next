import type { Meta, StoryObj } from "@storybook/nextjs"
import * as React from "react"

import { A2UISpacer } from "./a2ui-spacer"
import type { A2UISpacerComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const spacer = (over: Partial<A2UISpacerComponent> = {}): A2UISpacerComponent => ({
  id: "spacer",
  component: "Spacer",
  ...over,
})

// The spacer renders empty space, so frame it between two markers to make the
// gap legible in isolation.
const Framed = (Story: React.ComponentType) => (
  <div className="flex items-center">
    <div className="size-8 rounded bg-primary" />
    <Story />
    <div className="size-8 rounded bg-primary" />
  </div>
)

const meta = {
  title: "A2UI/Layout/Spacer",
  component: A2UISpacer,
  decorators: [Framed],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UISpacer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(spacer()) }

export const Small: Story = { args: makeA2UIProps(spacer({ size: 4 })) }

export const Large: Story = { args: makeA2UIProps(spacer({ size: 64 })) }
