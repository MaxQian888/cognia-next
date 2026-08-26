import type { Meta, StoryObj } from "@storybook/nextjs"
import { userEvent, within } from "storybook/test"
import type { UIMessage } from "ai"

import { ContextUsageIndicator } from "./context-usage-indicator"
import { useChatStore } from "@/stores/chat"
import type { SdkContextUsage } from "@cognia/agent-config-types"

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
  categories: [
    { name: "Messages", tokens: 150_000 },
    { name: "Memory files", tokens: 11_200 },
    { name: "System tools", tokens: 7_400 },
    { name: "MCP tools", tokens: 4_800 },
    { name: "System prompt", tokens: 2_400 },
    { name: "Custom agents", tokens: 200 },
    { name: "MCP tools (deferred)", tokens: 26_600, isDeferred: true },
    { name: "Free space", tokens: 24_000 },
  ],
  systemPromptSections: [{ name: "core", tokens: 2_400 }],
  systemTools: [
    { name: "Bash", tokens: 1_800 },
    { name: "Read", tokens: 1_500 },
    { name: "Edit", tokens: 1_400 },
    { name: "Grep", tokens: 1_300 },
    { name: "Glob", tokens: 1_400 },
  ],
  mcpTools: [
    { name: "wiki_read", serverName: "wiki", tokens: 3_200 },
    { name: "wiki_write", serverName: "wiki", tokens: 1_600 },
  ],
  memoryFiles: [
    { path: "CLAUDE.md", type: "project", tokens: 5_600 },
    { path: "MEMORY.md", type: "user", tokens: 5_600 },
  ],
  agents: [{ agentType: "reviewer", source: "project", tokens: 200 }],
  slashCommands: { totalCommands: 24, includedCommands: 24, tokens: 0 },
}

// Hover the trigger so the popover is on screen in the story canvas — the
// panel is the point of this component, and it only mounts while open.
const openPopover: Story["play"] = async ({ canvasElement }) => {
  await userEvent.hover(within(canvasElement).getByRole("button"))
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
  play: openPopover,
}

// Empty session — nothing sent yet, so the ring reads 0% and "Compact now" is
// disabled (graceful no-data fallback, no sidecar call).
export const EmptySession: Story = {
  beforeEach: seed([]),
  play: openPopover,
}

// Estimate path with the popover open — every row keeps a value and the
// detail section breaks the transcript down by source.
export const OpenPopover: Story = {
  play: openPopover,
}

// An external-agent turn that reported no token usage at all. The read-out must
// say "unknown", never 0% — the window holds a system prompt either way.
export const UsageNotReported: Story = {
  beforeEach: seed([
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "done", state: "done" }],
      metadata: { run: { providerId: "external" } },
    } as unknown as UIMessage,
  ]),
  play: openPopover,
}

// An external agent that DOES report occupancy (ACP `usage_update`): its own
// window size wins over this build's model table.
export const ExternalAgentReportedWindow: Story = {
  beforeEach: seed([
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "done", state: "done" }],
      // Exactly what the external lane stamps: the agent's own occupancy +
      // window, no prompt/completion split, and the lane marker that keeps the
      // sidecar's compaction policy off someone else's turn.
      metadata: {
        run: { providerId: "external" },
        usage: { contextTokens: 136_000, contextWindow: 272_000 },
      },
    } as unknown as UIMessage,
  ]),
  play: openPopover,
}
