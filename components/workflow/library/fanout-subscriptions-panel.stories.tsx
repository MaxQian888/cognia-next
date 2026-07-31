import type { Meta, StoryObj } from "@storybook/nextjs"

import { FanoutSubscriptionsPanel } from "./fanout-subscriptions-panel"
import { seedDb } from "@/lib/storybook/seed-db"

// Operator surface for "mirror every run of this workflow into channel Y".
// Reads adapters + subscription rows from Dexie; with an empty DB it renders the
// panel shell (add form + empty list), which is the realistic first-run state.
const meta = {
  title: "Workflow/Library/FanoutSubscriptionsPanel",
  component: FanoutSubscriptionsPanel,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto w-full max-w-xl">{Story()}</div>],
  args: { workflowId: "wf_demo" },
} satisfies Meta<typeof FanoutSubscriptionsPanel>

export default meta
type Story = StoryObj<typeof meta>

// Fresh install — no adapters configured, no subscriptions yet.
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
