import type { Meta, StoryObj } from "@storybook/nextjs"
import type { UIMessage } from "ai"
import { useTranslations } from "next-intl"

import { resolveMessageDisplayOptions } from "@/lib/chat/message-display"
import { MessageShell } from "./message-shell"

interface MessageShellStoryProps {
  display: ReturnType<typeof resolveMessageDisplayOptions>
  role?: "assistant" | "user"
  isStreaming?: boolean
}

const STORY_NOW = 1_700_000_000_000

function MessageShellStory({
  display,
  role = "assistant",
  isStreaming = false,
}: MessageShellStoryProps) {
  const t = useTranslations("chat.messageDisplay.story")
  const now = STORY_NOW
  const message: UIMessage = {
    id: `${role}-story`,
    role,
    parts: [
      { type: "text", text: role === "assistant" ? t("assistantAnswer") : t("userQuestion") },
    ],
    metadata: {
      createdAt: now,
      ...(role === "assistant"
        ? {
            usage: { inputTokens: 128, outputTokens: 512, totalCostUsd: 0.0042 },
            run: {
              providerId: "anthropic",
              modelId: "claude-sonnet-4-6",
              startedAt: now - 1450,
              completedAt: now,
              durationMs: 1450,
              finishReason: "success",
            },
          }
        : {}),
    },
  }
  return (
    <MessageShell message={message} display={display} isStreaming={isStreaming}>
      <p className="leading-7">
        {role === "assistant" ? t("rendererOwnership") : t("userQuestion")}
      </p>
    </MessageShell>
  )
}

const meta = {
  title: "Chat/MessageShell",
  component: MessageShellStory,
  parameters: { layout: "padded" },
  args: {
    display: resolveMessageDisplayOptions({ preset: "balanced" }),
  },
} satisfies Meta<typeof MessageShellStory>

export default meta
type Story = StoryObj<typeof meta>

export const Focused: Story = {
  args: { display: resolveMessageDisplayOptions({ preset: "focused" }) },
}

export const Balanced: Story = {}

export const Inspector: Story = {
  args: { display: resolveMessageDisplayOptions({ preset: "inspector" }) },
}

export const UserBubble: Story = {
  args: {
    role: "user",
    display: resolveMessageDisplayOptions({ preset: "balanced" }),
  },
}

export const Streaming: Story = { args: { isStreaming: true } }

export const NarrowMobile: Story = {
  decorators: [
    (Story) => (
      <div className="w-[320px]">
        <Story />
      </div>
    ),
  ],
}
