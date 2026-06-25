import type { Meta, StoryObj } from "@storybook/nextjs"
import type { UIMessage } from "ai"

import { ContextUsageIndicator } from "./context-usage-indicator"
import { useChatStore } from "@/stores/chat"
import type { SdkContextUsage } from "@/lib/claude/types"

// The single token / context-window read-out shown under the composer. It reads
// the chat store (messages → latest + session usage) and computes the fill ring;
// the sidecar is only touched by the "Compact now" button's onClick, never at
// mount — so it renders fine in Storybook. We seed the store with usage-bearing
// assistant turns and (optionally) pass `sdkUsage` to drive the fill level and
// per-category breakdown deterministically.

const SID = "demo-session"

// Assistant message carrying `metadata.usage` — the shape `getLatestUsage` /
// `sumSessionUsage` read.
const usageMsg = (
  id: string,
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
    totalCostUsd?: number
  }
): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text: id, state: "done" }],
    metadata: { usage },
  }) as unknown as UIMessage

const seed = (messages: UIMessage[]) => () => {
  const s = useChatStore.getState()
  s.closeSession(SID)
  s.setActiveSession(SID)
  s.replaceSessionMessages(SID, messages)
}

const TWO_TURNS = [
  usageMsg("a1", {
    inputTokens: 18_000,
    outputTokens: 2_400,
    cacheReadInputTokens: 9_000,
    totalCostUsd: 0.041,
  }),
  usageMsg("a2", {
    inputTokens: 31_000,
    outputTokens: 3_100,
    cacheReadInputTokens: 22_000,
    cacheCreationInputTokens: 4_000,
    totalCostUsd: 0.078,
  }),
]

// SDK-authoritative usage with a per-category breakdown (system prompt / tools /
// MCP / memory). `percentage` drives the headline; the component derives the
// ring + threshold marker from totalTokens / maxTokens.
const sdkCritical: SdkContextUsage = {
  totalTokens: 176_000,
  maxTokens: 200_000,
  percentage: 88,
  systemPromptSections: [{ name: "core", tokens: 2_400 }],
  systemTools: [{ name: "Bash", tokens: 1_800 }],
  mcpTools: [{ name: "wiki_read", serverName: "wiki", tokens: 3_200 }],
  memoryFiles: [{ path: "CLAUDE.md", type: "project", tokens: 5_600 }],
}

const meta = {
  title: "Chat/ContextUsageIndicator",
  component: ContextUsageIndicator,
  parameters: { layout: "centered" },
  args: {
    modelId: "claude-sonnet-4-5",
    providerId: "anthropic",
    maxTokens: 200_000,
  },
  beforeEach: seed(TWO_TURNS),
} satisfies Meta<typeof ContextUsageIndicator>

export default meta
type Story = StoryObj<typeof meta>

// Estimate path (no SDK usage): a comfortably-filled window — green ring. Open
// the trigger to see the per-turn input / output / cached rows + session total.
export const Healthy: Story = {}

// SDK-authoritative path near the auto-compact threshold — red ring plus the
// system-prompt / tools / MCP / memory breakdown in the hover card.
export const SdkAuthoritativeCritical: Story = {
  args: { sdkUsage: sdkCritical },
}

// Empty session — nothing sent yet, so the ring reads 0% and "Compact now" is
// disabled (graceful no-data fallback, no sidecar call).
export const EmptySession: Story = {
  beforeEach: seed([]),
}
