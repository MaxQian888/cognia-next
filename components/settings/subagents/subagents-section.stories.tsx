import type { Meta, StoryObj } from "@storybook/nextjs"

import { SubagentsSection } from "./subagents-section"
import { resetStores } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

// `SubagentsSection` is the master/detail shell for the SubAgent feature: a
// grouped nav (runtime · policy · built-in · mine · plugins) driving a single
// detail pane, addressed by the `?subagentTab=` search param. Templates come
// from the runtime store's seeded built-ins; the runtime panel stays empty
// until a dispatch pushes events.
//
// The section fills its frame (it is a member of the settings shell's
// `FILL_HEIGHT_SECTIONS`), so the decorator gives it a real height — without
// one the nav and detail panes collapse to nothing.
const meta = {
  title: "Settings/Subagents/SubagentsSection",
  component: SubagentsSection,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStores(useSettingsStore, useSubagentRuntimeStore)
  },
  decorators: [
    (Story) => (
      <div className="h-screen max-w-5xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SubagentsSection>

export default meta
type Story = StoryObj<typeof meta>

// Lands on the first template — the built-ins are seeded by the store.
export const Default: Story = {}
