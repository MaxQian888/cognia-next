import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UILoading, type A2UILoadingComponent } from "./a2ui-loading"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const loading = (over: Partial<A2UILoadingComponent> = {}): A2UILoadingComponent => ({
  id: "loading",
  component: "Loading",
  ...over,
})

const meta = {
  title: "A2UI/Display/Loading",
  component: A2UILoading,
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UILoading>

export default meta
type Story = StoryObj<typeof meta>

export const Spinner: Story = { args: makeA2UIProps(loading({ variant: "spinner" })) }

export const Dots: Story = { args: makeA2UIProps(loading({ variant: "dots" })) }

export const Pulse: Story = { args: makeA2UIProps(loading({ variant: "pulse" })) }

export const Small: Story = { args: makeA2UIProps(loading({ size: "sm" })) }

export const Large: Story = { args: makeA2UIProps(loading({ size: "lg" })) }

export const WithLabel: Story = {
  args: makeA2UIProps(loading({ size: "lg", text: "Crunching your data…" })),
}
