import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"

import {
  NESTING_DEFAULTS,
  SubagentNestingCard,
  type NestingPolicyValues,
} from "./subagent-nesting-card"

// `SubagentNestingCard` is the opt-in config for nested subagent dispatch
// (depth-N), backing `AppSettings.subagentNesting`. It is a controlled form:
// the draft, the dirty set and the single save live in the owning panel
// (`panels/policy-panels.tsx`), so these stories supply the state themselves.
// While the master switch is off, the depth/budget/timeout inputs are inert —
// but the retry dial stays live, because it also governs depth-1 dispatch.
const meta = {
  title: "Settings/Subagents/SubagentNestingCard",
  component: SubagentNestingCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-lg border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SubagentNestingCard>

export default meta
type Story = StoryObj<typeof meta>

function Controlled({ initial }: { initial: NestingPolicyValues }) {
  const [value, setValue] = useState(initial)
  return (
    <SubagentNestingCard
      value={value}
      onChange={(partial) => setValue((v) => ({ ...v, ...partial }))}
    />
  )
}

// `args` satisfy the controlled component's required props; the custom
// `render` supplies live state instead so the controls actually respond.
const ENABLED: NestingPolicyValues = {
  enabled: true,
  maxDepth: 3,
  tokenBudget: 200_000,
  timeoutSeconds: 120,
  dispatchMaxRetries: 2,
}

// Disabled — depth/budget/timeout inputs are inert.
export const Default: Story = {
  args: { value: NESTING_DEFAULTS, onChange: () => {} },
  render: () => <Controlled initial={NESTING_DEFAULTS} />,
}

// Enabled with a configured depth, token budget, and timeout.
export const Enabled: Story = {
  args: { value: ENABLED, onChange: () => {} },
  render: () => <Controlled initial={ENABLED} />,
}
