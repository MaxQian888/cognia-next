import type { Meta, StoryObj } from "@storybook/nextjs"

import { DiagnosticsCard } from "./diagnostics-card"
import type {
  ContextDiagnosticsBlock,
  CostDiagnosticsBlock,
  DiagnosticsWindow,
  UsageDiagnosticsBlock,
} from "@/lib/slash-commands/system-blocks"

const window: DiagnosticsWindow = {
  used: 92_000,
  max: 200_000,
  fraction: 0.46,
  remaining: 108_000,
  level: "warn",
  compactThresholdTokens: 160_000,
  autoCompactFraction: 0.8,
}

const meta = {
  title: "Chat/MessageParts/DiagnosticsCard",
  component: DiagnosticsCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof DiagnosticsCard>

export default meta
type Story = StoryObj<typeof meta>

// /context — buffer turns + window occupancy + token breakdown with cache.
export const Context: Story = {
  args: {
    block: {
      kind: "context",
      userTurns: 14,
      assistantTurns: 13,
      tokens: { input: 48_000, output: 21_000, cacheRead: 30_000, cacheCreate: 8_000 },
      window,
    } satisfies ContextDiagnosticsBlock,
  },
}

// /cost — cumulative billed usage with an estimated cost + duration row.
export const Cost: Story = {
  args: {
    block: {
      kind: "cost",
      assistantTurns: 13,
      metricTurns: 11,
      inputTokens: 86_000,
      outputTokens: 21_500,
      cacheCreateTokens: 8_000,
      cacheReadTokens: 30_000,
      costUsd: 0.4231,
      costEstimated: true,
      durationMs: 42_300,
      window,
    } satisfies CostDiagnosticsBlock,
  },
}

// /usage — Anthropic subscription quota windows (one reported, one not).
export const Usage: Story = {
  args: {
    block: {
      kind: "usage",
      windows: [
        { key: "fiveHour", utilization: 72, level: "warn", msUntilReset: 1000 * 60 * 95 },
        { key: "sevenDay", utilization: null, level: null, msUntilReset: null },
      ],
      fallbackPercentage: 12,
      overageDisabledReason: null,
    } satisfies UsageDiagnosticsBlock,
  },
}
