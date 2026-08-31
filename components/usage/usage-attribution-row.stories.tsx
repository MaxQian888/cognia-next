import type { Meta, StoryObj } from "@storybook/nextjs"

import { UsageAttributionRow } from "./usage-attribution-row"

// The shared "who spent this" row, used by the Usage dashboard's per-surface
// breakdown and by the /usage transcript card. The three states worth looking
// at side by side are a priced bucket, a partially priced one (lower bound) and
// a fully unpriced one (no figure at all).
const meta = {
  title: "Usage/UsageAttributionRow",
  component: UsageAttributionRow,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <ul className="max-w-md space-y-2.5">
        <Story />
      </ul>
    ),
  ],
} satisfies Meta<typeof UsageAttributionRow>

export default meta
type Story = StoryObj<typeof meta>

export const Priced: Story = {
  args: {
    id: "chat",
    label: "Chat",
    pct: 68,
    costUsd: 12.4,
    unpricedTurns: 0,
    turns: 214,
    detail: "214 turns · 4.1M tokens",
    reduce: true,
  },
}

export const LowerBound: Story = {
  args: {
    id: "workflow",
    label: "Workflow",
    pct: 22,
    costUsd: 3.95,
    unpricedTurns: 6,
    turns: 40,
    detail: "40 turns · 900.0K tokens",
    reduce: true,
  },
}

export const FullyUnpriced: Story = {
  args: {
    id: "embedding",
    label: "Embedding",
    pct: 4,
    costUsd: 0,
    unpricedTurns: 18,
    turns: 18,
    detail: "18 turns · 620.0K tokens",
    reduce: true,
  },
}
