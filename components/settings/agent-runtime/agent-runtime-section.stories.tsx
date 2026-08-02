import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentRuntimeSection } from "./agent-runtime-section"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// `AgentRuntimeSection` is the master/detail shell for the in-process Claude
// SDK runtime (Defaults / Permissions / Sessions / Sidecar / A2UI). The active
// panel is driven by the `?agentRuntimeTab=` search param (App Router mocks
// supplied by the preview); it defaults to "defaults". Every panel reads the
// settings store + an empty Dexie database in the web preview.
const meta = {
  title: "Settings/AgentRuntime/AgentRuntimeSection",
  component: AgentRuntimeSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[720px] max-w-5xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentRuntimeSection>

export default meta
type Story = StoryObj<typeof meta>

// Defaults panel (the landing panel).
export const Default: Story = {}
