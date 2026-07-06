import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UISpinner, type A2UISpinnerComponent } from "./a2ui-spinner"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const spinner = (over: Partial<A2UISpinnerComponent> = {}): A2UISpinnerComponent => ({
  id: "spinner",
  component: "Spinner",
  ...over,
})

const meta = {
  title: "A2UI/Display/Spinner",
  component: A2UISpinner,
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UISpinner>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(spinner()) }

export const Small: Story = { args: makeA2UIProps(spinner({ size: "sm" })) }

export const Large: Story = { args: makeA2UIProps(spinner({ size: "lg" })) }

export const WithLabel: Story = {
  args: makeA2UIProps(spinner({ size: "lg", label: "Loading workspace…" })),
}
