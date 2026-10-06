import type { Meta, StoryObj } from "@storybook/nextjs"
import type { UIMessage } from "ai"
import { useTranslations } from "next-intl"

import { resolveMessageDisplayOptions } from "@/lib/chat/message-display"
import { MessageMetaLine, MessageShell } from "./message-shell"
import { TranscriptAgentsProvider } from "./transcript-agents-context"

interface MessageShellStoryProps {
  display: ReturnType<typeof resolveMessageDisplayOptions>
  role?: "assistant" | "user"
  isStreaming?: boolean
  /** Sealed `run.agent` stamp — what a completed turn carries. */
  agent?: { presetId: string; name: string; icon: string }
  /** Render inside a transcript where several agents answered (ADR-0218). */
  multiAgent?: boolean
}

const STORY_NOW = 1_700_000_000_000

function MessageShellStory({
  display,
  role = "assistant",
  isStreaming = false,
  agent,
  multiAgent = false,
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
              agent,
            },
          }
        : {}),
    },
  }
  return (
    <TranscriptAgentsProvider multiAgent={multiAgent}>
      <MessageShell message={message} display={display} isStreaming={isStreaming}>
        <p className="leading-7">
          {role === "assistant" ? t("rendererOwnership") : t("userQuestion")}
        </p>
        {/* The meta chip lives on the renderer's action row; here it stands in
          for that row so the popover stays visible in isolation. */}
        <div className="mt-1 flex">
          <MessageMetaLine message={message} display={display} className="ml-auto" />
        </div>
      </MessageShell>
    </TranscriptAgentsProvider>
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

/**
 * A turn sealed under the Build preset, in a transcript where another agent
 * also answered: the header names it with its icon. Alone, it stays quiet.
 */
export const PresetIdentity: Story = {
  args: { agent: { presetId: "build", name: "Build", icon: "Hammer" }, multiAgent: true },
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
