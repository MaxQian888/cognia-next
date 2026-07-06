import type { Meta, StoryObj } from "@storybook/nextjs"

import { SubagentRuntimeTab } from "./subagent-runtime-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

// `SubagentRuntimeTab` is a live read of the runtime registry maintained by
// `subagent-runtime-store`. It's empty until a Rust orchestrator pushes
// subagent events, so the default surface is the explanatory empty state +
// the "agent teams" callout banner.
const meta = {
  title: "Settings/Subagents/SubagentRuntimeTab",
  component: SubagentRuntimeTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSubagentRuntimeStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SubagentRuntimeTab>

export default meta
type Story = StoryObj<typeof meta>

// No live subagents — empty state + callout.
export const Default: Story = {}
