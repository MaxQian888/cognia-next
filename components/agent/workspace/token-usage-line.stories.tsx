import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { TokenUsageLine } from "./token-usage-line"

const meta = {
  title: "Agent/TokenUsageLine",
  component: TokenUsageLine,
  args: { usage: { promptTokens: 820, completionTokens: 240, totalTokens: 1060 } },
} satisfies Meta<typeof TokenUsageLine>

export default meta
type Story = StoryObj<typeof meta>

export const Small: Story = {}

// Exercises the formatter thresholds: 2.34k → 12.3k → 4.5M.
export const ThousandsBoundary: Story = {
  args: { usage: { promptTokens: 2340, completionTokens: 980, totalTokens: 3320 } },
}

export const TensOfThousands: Story = {
  args: { usage: { promptTokens: 12_300, completionTokens: 4500, totalTokens: 16_800 } },
}

export const Millions: Story = {
  args: { usage: { promptTokens: 4_500_000, completionTokens: 1_200_000, totalTokens: 5_700_000 } },
}

// null / all-zero usage renders nothing.
export const Hidden: Story = {
  args: { usage: null },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <TokenUsageLine {...args} />
    </div>
  ),
}
