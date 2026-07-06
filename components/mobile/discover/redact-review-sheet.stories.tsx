import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { RedactReviewSheet } from "./redact-review-sheet"

// On-device PII review before a text ingest leaves the phone. Pure w.r.t. its
// props — `redactText` (a synchronous lib) computes the redacted preview and
// the masked-entity count. Open by default so the sheet body is visible.
const meta = {
  title: "Mobile/Discover/RedactReviewSheet",
  component: RedactReviewSheet,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    onConfirm: fn(),
    text:
      "Hi, I'm Jane Doe — reach me at jane.doe@example.com or +1 415-555-0137. " +
      "My card is 4111 1111 1111 1111 and I live at 1 Market St, San Francisco.",
  },
} satisfies Meta<typeof RedactReviewSheet>

export default meta
type Story = StoryObj<typeof meta>

export const WithDetectedPii: Story = {}

export const ShortText: Story = {
  args: { text: "Ping me at sam@example.com about the Q3 plan." },
}
