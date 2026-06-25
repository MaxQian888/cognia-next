import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { GoalStatusPill } from "./goal-status-pill"
import type { Goal } from "@/types/goal"

// Mirrors the fixture in goal-status-pill.test.tsx — `goalOverride` bypasses the
// live `useOpenGoal` hook for tests and Storybook.
const NOW = Date.now()
const baseGoal: Goal = {
  id: "g1",
  sessionId: "ses_a",
  rawObjective: "ship feature flag",
  safeObjective: "ship feature flag",
  redactionMapEnc: "",
  status: "active",
  turnsUsed: 3,
  tokensUsed: 12_340,
  judgeFailureCount: 0,
  config: {
    maxTurns: 20,
    maxTokens: 200_000,
    maxJudgeFailures: 3,
    timeoutMs: 30 * 60_000,
  },
  generationId: "gen-1",
  createdAt: NOW,
  updatedAt: NOW,
}

const meta = {
  title: "Goal/GoalStatusPill",
  component: GoalStatusPill,
  args: { sessionId: "ses_a", goalOverride: baseGoal },
  parameters: { layout: "padded" },
} satisfies Meta<typeof GoalStatusPill>

export default meta
type Story = StoryObj<typeof meta>

export const Active: Story = {}

export const ManualContinue: Story = {
  args: {
    goalOverride: { ...baseGoal, config: { ...baseGoal.config, manualContinue: true } },
  },
}

export const NextContinuationFootnote: Story = {
  args: {
    goalOverride: {
      ...baseGoal,
      nextContinuationAt: NOW + 30 * 60_000,
      nextContinuationSource: "model_suggested",
    },
  },
}

export const Paused: Story = {
  args: { goalOverride: { ...baseGoal, status: "paused" } },
}

// goalOverride === null renders nothing.
export const NoGoal: Story = {
  args: { goalOverride: null },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <GoalStatusPill {...args} />
    </div>
  ),
}
