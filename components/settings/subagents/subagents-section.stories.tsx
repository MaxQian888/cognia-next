import type { Meta, StoryObj } from "@storybook/nextjs"

import { SubagentsSection } from "./subagents-section"
import { resetStores } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

// `SubagentsSection` is the settings shell for the SubAgent feature: the
// nesting card plus a Templates / Runtime tab switcher (driven by the
// `?subagentTab=` search param). Templates come from the runtime store's
// seeded built-ins; the runtime tab is empty until an orchestrator pushes
// events.
const meta = {
  title: "Settings/Subagents/SubagentsSection",
  component: SubagentsSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStores(useSettingsStore, useSubagentRuntimeStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SubagentsSection>

export default meta
type Story = StoryObj<typeof meta>

// Templates tab (the landing tab) with the built-in subagent templates.
export const Default: Story = {}
