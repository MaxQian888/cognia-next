import type { Meta, StoryObj } from "@storybook/nextjs"
import type { UIMessage } from "ai"

import { analyzeSession } from "@/lib/analysis/session-report"
import {
  buildEstimateContextBreakdown,
  buildSdkContextBreakdown,
  resolveAutoCompaction,
} from "@/lib/claude/context-breakdown"
import { resolveContextWindowUsage } from "@/lib/claude/usage"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { SessionContextWindow } from "@/hooks/chat/use-session-context-window"
import { SessionUsagePanelView } from "./session-usage-panel"

// The conversation's "Usage & context" dock panel, fed a deterministic
// eighteen-turn coding session: context creeping up to the compaction line, one
// compaction, a model switch, a mix of tools with a few failures.

const T0 = new Date(2026, 9, 3, 14, 0).getTime()
const pricing = () => ({ promptPer1M: 3, completionPer1M: 15, cachedInputPer1M: 0.3 })

function rows(): SessionUsageRow[] {
  const out: SessionUsageRow[] = []
  let context = 18_000
  for (let i = 1; i <= 18; i += 1) {
    context = i === 12 ? 42_000 : Math.round(context * 1.15 + 4_000)
    const cached = Math.round(context * 0.82)
    out.push({
      messageId: `a${i}`,
      sessionId: "story",
      at: T0 + i * 95_000,
      model: i > 14 ? "claude-opus-4-7" : "claude-sonnet-4-6",
      providerId: "anthropic",
      inputTokens: context - cached - 1_200,
      cacheReadTokens: cached,
      cacheCreationTokens: 1_200,
      contextInputTokens: context,
      outputTokens: 600 + ((i * 397) % 2_400),
      reasoningTokens: 200 + ((i * 131) % 700),
      durationMs: 6_000 + ((i * 2_311) % 21_000),
      costUsd: 0,
      surface: "chat",
    })
  }
  return out
}

function messages(): UIMessage[] {
  const tools = [
    ["Read", 26],
    ["Bash", 19],
    ["Edit", 14],
    ["Grep", 11],
    ["Glob", 6],
    ["WebFetch", 3],
    ["mcp__wiki__read", 2],
  ] as const
  const parts: Array<Record<string, unknown>> = []
  for (const [tool, count] of tools) {
    for (let i = 0; i < count; i += 1) {
      parts.push({
        type: `tool-${tool}`,
        state: tool === "Bash" && i % 6 === 0 ? "output-error" : "output-available",
        input: { command: `cmd-${i}`, file_path: `src/file-${i}.ts` },
      })
    }
  }
  return [{ id: "a1", role: "assistant", parts }] as unknown as UIMessage[]
}

const report = analyzeSession({ messages: messages(), usageRows: rows() }, { resolve: pricing })

function liveContext(): SessionContextWindow {
  const snapshot = {
    totalTokens: 136_000,
    maxTokens: 200_000,
    percentage: 68,
    categories: [
      { name: "Messages", tokens: 84_000 },
      { name: "System tools", tokens: 21_000 },
      { name: "MCP tools", tokens: 14_000 },
      { name: "System prompt", tokens: 8_500 },
      { name: "Memory files", tokens: 5_000 },
      { name: "Skills", tokens: 3_500 },
      { name: "Free space", tokens: 64_000 },
    ],
  }
  const win = resolveContextWindowUsage(snapshot, null, "claude-sonnet-4-6")
  return {
    win,
    breakdown: buildSdkContextBreakdown(snapshot),
    compaction: resolveAutoCompaction(snapshot, { occupancyReported: true, agentOwned: false }),
    agentOwned: false,
    assistantTurns: 18,
    refresh: () => {},
  }
}

function estimatedContext(): SessionContextWindow {
  const win = resolveContextWindowUsage(null, { inputTokens: 9_000 }, "gpt-4.1", 128_000)
  const transcript = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Summarise the release notes. ".repeat(80) }],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "Here is the summary. ".repeat(160) }],
    },
  ] as unknown as UIMessage[]
  return {
    win,
    breakdown: buildEstimateContextBreakdown(transcript, win.used, win.max),
    compaction: resolveAutoCompaction(null, { occupancyReported: true, agentOwned: false }),
    agentOwned: false,
    assistantTurns: 1,
    refresh: () => {},
  }
}

const meta = {
  title: "ContextWorkbench/SessionUsagePanel",
  component: SessionUsagePanelView,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[1800px] w-[440px] border-r bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionUsagePanelView>

export default meta
type Story = StoryObj<typeof meta>

export const LiveCodingSession: Story = {
  args: {
    sessionId: "story",
    report,
    loading: false,
    context: liveContext(),
    rank: { percentile: 86, peers: 41, medianUsd: 0.38 },
    onJump: () => {},
    onOpenReport: () => {},
  },
}

export const EstimatedWindowNoTurns: Story = {
  args: {
    sessionId: "story",
    report: analyzeSession({ messages: [], usageRows: [] }),
    loading: false,
    context: estimatedContext(),
    rank: null,
  },
}
