import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AnthropicAddAccountDialog } from "./anthropic"

// Two-step Claude PKCE OAuth dialog. Props-only: `open` controls visibility,
// `initialMode` selects the default radio (subscription vs console), and
// `onOpenChange` / `onAdded` are the callbacks. The dialog opens on the
// "choose-mode" step; advancing to the paste-code step needs a real browser
// OAuth round-trip, so the stories document the initial step in both modes.
const meta = {
  title: "Settings/Subscription/AddAccountDialog/AnthropicAddAccountDialog",
  component: AnthropicAddAccountDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    onAdded: fn(),
    initialMode: "subscription",
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof AnthropicAddAccountDialog>

export default meta
type Story = StoryObj<typeof meta>

export const SubscriptionMode: Story = {}

export const ConsoleMode: Story = {
  args: { initialMode: "console" },
}

export const Closed: Story = {
  args: { open: false },
}
