import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OpencodeAddAccountDialog } from "./opencode"

// OpenCode "paste API key" dialog. Props-only: `open` controls visibility,
// `onOpenChange` / `onAdded` are callbacks. The form (plan radio, access token,
// base URL, label) lives entirely in component state and defaults to the Zen
// plan when opened.
const meta = {
  title: "Settings/Subscription/AddAccountDialog/OpencodeAddAccountDialog",
  component: OpencodeAddAccountDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    onAdded: fn(),
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof OpencodeAddAccountDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Closed: Story = {
  args: { open: false },
}
