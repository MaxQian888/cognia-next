import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ShareLinkDialog } from "./share-link-dialog"
import type { SharePayload } from "@/lib/share/types"

const payload: SharePayload = {
  kind: "chat-text",
  mime: "text/plain",
  encoding: "utf8",
  title: "Shared conversation",
  data: "User: How do I rate-limit a function?\n\nAssistant: Use a sliding window…",
}

// Reusable "Share via link" dialog. The default view shows the TTL / view-limit
// / passphrase form before the user commits. (Creating a link requires a
// configured share worker, absent in Storybook.)
const meta = {
  title: "Share/ShareLinkDialog",
  component: ShareLinkDialog,
  args: { buildPayload: () => payload, open: true, onOpenChange: fn(), onConfigure: fn() },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ShareLinkDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Form: Story = {}

export const Closed: Story = {
  args: { open: false },
}
