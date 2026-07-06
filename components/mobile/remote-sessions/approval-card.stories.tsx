import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ApprovalCard } from "./approval-card"
import { makePendingApproval } from "@/lib/storybook/fixtures/mobile"

// Tool-use approval routed from a host agent to this phone. Pure: `approval`
// drives the heading + input preview; allow is biometric-gated (only on tap),
// deny resolves immediately through `onRespond`.
const meta = {
  title: "Mobile/RemoteSessions/ApprovalCard",
  component: ApprovalCard,
  parameters: { layout: "fullscreen" },
  args: { onRespond: fn(async () => undefined) },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ApprovalCard>

export default meta
type Story = StoryObj<typeof meta>

/** A Bash command awaiting approval. */
export const BashCommand: Story = {
  args: { approval: makePendingApproval() },
}

/** A computer-use action with no separate description line. */
export const ComputerUse: Story = {
  args: {
    approval: makePendingApproval({
      toolName: "computer",
      displayName: "Control the screen",
      description: undefined,
      input: { action: "left_click", coordinate: [640, 360] },
    }),
  },
}
