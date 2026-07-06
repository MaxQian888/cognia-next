import type { Meta, StoryObj } from "@storybook/nextjs"

import { SessionCostBadge } from "./session-cost-badge"
import type { UsageInfo } from "@/lib/claude/adapter"

// Per-session cost / token badge for the chat header. The collapsed badge shows
// in-memory totals; the popover enriches it with the persisted per-model split
// (empty here — Storybook opens a fresh, empty IndexedDB). Click to expand.
const usage = (over: Partial<UsageInfo> = {}): UsageInfo => ({
  inputTokens: 12_400,
  outputTokens: 3_200,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  totalCostUsd: 0.0421,
  ...over,
})

const tokensLabel = (input: string, output: string) => `${input} in / ${output} out`

const meta = {
  title: "Chat/SessionCostBadge",
  component: SessionCostBadge,
  parameters: { layout: "centered" },
  args: {
    sessionId: "demo-session",
    inMemoryUsage: usage(),
    tokensLabel,
  },
} satisfies Meta<typeof SessionCostBadge>

export default meta
type Story = StoryObj<typeof meta>

/** Tokens + cost; click the badge for the (empty) per-model breakdown. */
export const Default: Story = {}

/** Large token counts format with k / M suffixes. */
export const LargeUsage: Story = {
  args: {
    inMemoryUsage: usage({ inputTokens: 1_240_000, outputTokens: 86_000, totalCostUsd: 4.21 }),
  },
}

/** No cost yet — only the token label shows. */
export const NoCost: Story = {
  args: { inMemoryUsage: usage({ inputTokens: 800, outputTokens: 120, totalCostUsd: 0 }) },
}
