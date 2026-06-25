import type { Meta, StoryObj } from "@storybook/nextjs"
import type { UIMessage } from "ai"

import { SessionNoticeMarker, type SessionNoticePartData } from "./session-notice-part"

const message = (part: SessionNoticePartData): UIMessage =>
  ({
    id: "notice-1",
    role: "system",
    parts: [part],
  }) as unknown as UIMessage

const meta = {
  title: "Chat/MessageParts/SessionNoticeMarker",
  component: SessionNoticeMarker,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SessionNoticeMarker>

export default meta
type Story = StoryObj<typeof meta>

// A tool auto-denied without an interactive prompt — names the blocked tool.
export const PermissionDenied: Story = {
  args: {
    message: message({
      type: "session-notice",
      variant: "permission-denied",
      toolName: "Bash",
      reason: "blocked by deny rule",
    }),
  },
}

// Subscription rate limit rejected, with a reset time.
export const RateLimit: Story = {
  args: {
    message: message({
      type: "session-notice",
      variant: "rate-limit",
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: Math.floor(Date.now() / 1000) + 60 * 90,
    }),
  },
}
