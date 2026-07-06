import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIWidgetStatus } from "./a2ui-widget-status"
import type { A2UIWidgetStatusComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const status = (over: Partial<A2UIWidgetStatusComponent> = {}): A2UIWidgetStatusComponent => ({
  id: "widget-status",
  component: "WidgetStatus",
  status: "ready",
  title: "Sales dashboard",
  message: "Widget rendered successfully.",
  ...over,
})

const meta = {
  title: "A2UI/Display/WidgetStatus",
  component: A2UIWidgetStatus,
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIWidgetStatus>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = { args: makeA2UIProps(status()) }

export const Loading: Story = {
  args: makeA2UIProps(
    status({ status: "loading", title: "Sales dashboard", message: "Fetching the latest data…" })
  ),
}

export const Fallback: Story = {
  args: makeA2UIProps(
    status({
      status: "fallback",
      title: "Sales dashboard",
      message: "Showing cached results while the live widget loads.",
    })
  ),
}

export const ErrorState: Story = {
  args: makeA2UIProps(
    status({
      status: "error",
      title: "Sales dashboard",
      message: "The widget failed to render.",
    })
  ),
}

export const WithDetail: Story = {
  args: makeA2UIProps(
    status({
      status: "error",
      title: "Sales dashboard",
      message: "The widget failed to render.",
      detail: "TypeError: Cannot read properties of undefined (reading 'rows').",
    })
  ),
}

export const WithRetryAction: Story = {
  args: makeA2UIProps(
    status({
      status: "error",
      title: "Sales dashboard",
      message: "The widget failed to render.",
      detail: "Connection to the data source timed out.",
      action: "retry-widget",
      actionLabel: "Retry",
    })
  ),
}

export const MessageOnly: Story = {
  args: makeA2UIProps(
    status({ status: "ready", title: undefined, message: "All systems operational." })
  ),
}
