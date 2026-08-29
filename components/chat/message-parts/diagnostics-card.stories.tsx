import type { Meta, StoryObj } from "@storybook/nextjs"

import { DiagnosticsCard } from "./diagnostics-card"
import type {
  ContextDiagnosticsBlock,
  CostDiagnosticsBlock,
  DiagnosticsWindow,
  UsageDiagnosticsBlock,
} from "@/lib/slash-commands/system-blocks"
import { buildUsageScope } from "@/lib/usage/usage-report"
import type { SessionUsageRow } from "@/lib/db/session-usage"

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

// /usage — the full card: fused quota windows (including the per-model weekly
// tiers only the usage endpoint reports), a pay-as-you-go meter, and local spend
// attributed across scopes.
const NOW = new Date("2026-08-29T12:00:00Z").getTime()
const HOUR = 3_600_000

function usageRow(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: `m-${Math.random()}`,
    sessionId: "s1",
    at: NOW,
    model: "claude-opus-5",
    providerId: "anthropic",
    inputTokens: 1_400,
    outputTokens: 5_500,
    cacheCreationTokens: 1_100_000,
    cacheReadTokens: 244_000_000,
    costUsd: 86.79,
    durationMs: 137_000,
    costSource: "sdk",
    costKnown: true,
    surface: "chat",
    ...overrides,
  }
}

export const Usage: Story = {
  args: {
    block: {
      kind: "usage",
      meters: [
        {
          id: "session",
          labelKey: "subscription.limits.meter.session",
          kind: "window",
          usedPct: 11,
          resetAt: NOW + 2 * HOUR + 41 * 60_000,
          status: "ok",
        },
        {
          id: "weekly",
          labelKey: "subscription.limits.meter.weekly",
          kind: "window",
          usedPct: 82,
          resetAt: NOW + 3 * 24 * HOUR,
          status: "warn",
        },
        {
          id: "weekly_opus",
          labelKey: "subscription.limits.meter.weekly_opus",
          kind: "window",
          usedPct: 0,
          resetAt: NOW + 3 * 24 * HOUR,
          status: "ok",
        },
      ],
      extras: [
        {
          id: "overage",
          labelKey: "subscription.limits.meter.overage",
          kind: "balance",
          usedPct: 40,
          used: 40,
          total: 100,
          remaining: 60,
          currency: "USD",
          status: "ok",
        },
      ],
      source: "endpoint",
      fetchedAt: NOW - 60_000,
      status: null,
      representativeClaim: "five_hour",
      fallbackPercentage: 0.2,
      overageDisabledReason: null,
      scopes: [
        buildUsageScope("session", [usageRow()]),
        buildUsageScope("today", [
          usageRow(),
          usageRow({ surface: "agent-team", costUsd: 12, model: "claude-sonnet-5" }),
          usageRow({ surface: "workflow", costUsd: 3, model: "claude-haiku-4-5" }),
        ]),
        buildUsageScope("week", [
          usageRow(),
          usageRow({ surface: "agent-team", costUsd: 12, model: "claude-sonnet-5" }),
          usageRow({ surface: "workflow", costUsd: 3, model: "claude-haiku-4-5" }),
          usageRow({ surface: "ocr", costUsd: 0, costSource: "unknown", costKnown: false }),
        ]),
      ],
      hasSession: true,
      notes: [],
      generatedAt: NOW,
    } satisfies UsageDiagnosticsBlock,
  },
}

// Every plane degraded at once: no desktop keychain, no account, no local rows.
export const UsageDegraded: Story = {
  args: {
    block: {
      kind: "usage",
      meters: [],
      extras: [],
      source: null,
      fetchedAt: null,
      status: null,
      representativeClaim: null,
      fallbackPercentage: null,
      overageDisabledReason: null,
      scopes: [
        buildUsageScope("session", []),
        buildUsageScope("today", []),
        buildUsageScope("week", []),
      ],
      hasSession: false,
      notes: [
        { id: "web-mode" },
        { id: "no-account" },
        { id: "no-local-spend" },
        { id: "quota-error", detail: "429 Too Many Requests" },
      ],
      generatedAt: NOW,
    } satisfies UsageDiagnosticsBlock,
  },
}

// A v1 block, as recorded before the block carried fused meters.
export const UsageLegacyBlock: Story = {
  args: {
    block: {
      kind: "usage",
      windows: [
        { key: "fiveHour", utilization: 72, level: "warn", msUntilReset: 1000 * 60 * 95 },
        { key: "sevenDay", utilization: null, level: null, msUntilReset: null },
      ],
      fallbackPercentage: 0.12,
      overageDisabledReason: null,
    } satisfies UsageDiagnosticsBlock,
  },
}
