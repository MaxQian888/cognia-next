import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { LoopStatusPill } from "./loop-status-pill"
import type { Loop } from "@/types/loop"

// Mirrors the fixture in loop-status-pill.test.tsx — the `loopOverride` prop is
// purpose-built for tests and Storybook to bypass the live `useOpenLoop` hook.
const NOW = Date.now()
const baseLoop: Loop = {
  id: "lp1",
  sessionId: "ses_a",
  mode: "self_paced",
  rawPrompt: "summarize new commits",
  safePrompt: "summarize new commits",
  redactionMapEnc: "",
  isSlashCommand: false,
  status: "active",
  iterations: 3,
  tokensUsed: 12_340,
  generationId: "gen-1",
  config: {
    maxIterations: 100,
    maxTokens: 1_000_000,
    minDelayMs: 60_000,
    maxDelayMs: 3_600_000,
    maxParseFailures: 3,
  },
  parseFailureCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
}

const meta = {
  title: "Loop/LoopStatusPill",
  component: LoopStatusPill,
  args: { sessionId: "ses_a", loopOverride: baseLoop },
  parameters: { layout: "padded" },
} satisfies Meta<typeof LoopStatusPill>

export default meta
type Story = StoryObj<typeof meta>

export const SelfPacedActive: Story = {}

export const SelfPacedWithFootnote: Story = {
  args: {
    loopOverride: { ...baseLoop, nextDelayMs: 300_000, nextDelayReason: "build running" },
  },
}

export const IntervalMode: Story = {
  args: { loopOverride: { ...baseLoop, mode: "interval", intervalMs: 300_000 } },
}

export const Paused: Story = {
  args: { loopOverride: { ...baseLoop, status: "paused" } },
}

// loopOverride === null renders nothing.
export const NoLoop: Story = {
  args: { loopOverride: null },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <LoopStatusPill {...args} />
    </div>
  ),
}
