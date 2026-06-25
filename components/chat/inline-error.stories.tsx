import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { InlineError } from "./inline-error"

const meta = {
  title: "Chat/InlineError",
  component: InlineError,
  args: {
    onRetry: fn(),
    onOpenSettings: fn(),
    onDismiss: fn(),
  },
} satisfies Meta<typeof InlineError>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    message: "Request failed: the upstream provider returned a 503.",
  },
}

export const ApiKeyError: Story = {
  args: {
    message: "Authentication failed: missing or invalid API key.",
  },
}

export const MessageOnly: Story = {
  args: {
    message: "Something went wrong while streaming the response.",
    onRetry: undefined,
    onOpenSettings: undefined,
    onDismiss: undefined,
  },
}
