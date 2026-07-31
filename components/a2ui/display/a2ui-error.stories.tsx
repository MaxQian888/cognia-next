import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIError, type A2UIErrorComponent } from "./a2ui-error"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const error = (over: Partial<A2UIErrorComponent> = {}): A2UIErrorComponent => ({
  id: "error",
  component: "Error",
  message: "Something went wrong while loading your data.",
  ...over,
})

const meta = {
  title: "A2UI/Display/Error",
  component: A2UIError,
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UIError>

export default meta
type Story = StoryObj<typeof meta>

export const Inline: Story = {
  args: makeA2UIProps(error({ variant: "inline", message: "Could not reach the server." })),
}

export const Card: Story = {
  args: makeA2UIProps(
    error({
      variant: "card",
      title: "Request failed",
      message: "The request timed out. Please try again.",
    })
  ),
}

export const Fullpage: Story = {
  args: makeA2UIProps(
    error({
      variant: "fullpage",
      title: "We hit a snag",
      message: "This page is temporarily unavailable.",
    })
  ),
}

export const WithRetry: Story = {
  args: makeA2UIProps(
    error({
      variant: "card",
      title: "Sync failed",
      message: "Your changes could not be saved.",
      retryAction: "retry-sync",
      retryLabel: "Try again",
    }),
    { onAction: fn() }
  ),
}

export const StackTrace: Story = {
  args: makeA2UIProps(
    error({
      variant: "card",
      title: "Unhandled exception",
      message:
        "Error: Cannot read properties of undefined (reading 'id')\n    at renderSurface (a2ui.tsx:42:11)\n    at dispatchAction (bus.ts:88:7)",
    })
  ),
}
