import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentTraceStatsBarView } from "./agent-trace-stats-bar"
import type { AgentTraceStatsSummary } from "@/lib/db/agent-traces"

// `AgentTraceStatsBarView` is the pure surface split from the Dexie live-query
// wrapper. Pass `summary === null` for loading; a literal summary populates the
// KPI cards + per-model breakdown.
const SUMMARY: AgentTraceStatsSummary = {
  totalCost: 4.82,
  toolCallCount: 36,
  toolFailureCount: 2,
  avgLatencyMs: 1840,
  eventTypeCounts: { invoke_agent: 8, chat: 8, execute_tool: 8 },
  totalSpans: 24,
  totalInputTokens: 38_400,
  totalOutputTokens: 9_120,
  totalCacheReadTokens: 12_800,
  totalCacheCreationTokens: 2_400,
  cacheHitRate: 0.25,
  errorCount: 2,
  byModel: {
    "claude-3-5-sonnet-20241022": {
      spans: 12,
      inputTokens: 22_000,
      outputTokens: 5_400,
      costUsd: 2.9,
    },
    "gpt-4o-2024-08-06": { spans: 8, inputTokens: 12_000, outputTokens: 2_800, costUsd: 1.42 },
    "claude-3-opus-20240229": { spans: 4, inputTokens: 4_400, outputTokens: 920, costUsd: 0.5 },
  },
  bySurface: { chat: 12, "agent-team": 8, workflow: 4 },
}

const meta = {
  title: "Logging/AgentTraceStatsBar",
  component: AgentTraceStatsBarView,
  parameters: { layout: "padded" },
  args: { summary: SUMMARY, window: "today" },
} satisfies Meta<typeof AgentTraceStatsBarView>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

export const WeekWindow: Story = { args: { window: "week" } }

export const Loading: Story = { args: { summary: null } }
