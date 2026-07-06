import type { Meta, StoryObj } from "@storybook/nextjs"

import { DefaultsTab } from "./defaults-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeAgentAppSettings,
  makeConfiguredDefaults,
} from "@/lib/storybook/fixtures/settings-agent"

// `DefaultsTab` edits the agent-runtime defaults (permission mode, default
// model, working dir, append system prompt, thinking budget, routing fallback,
// output style, bare/brief modes). All fields back `AppSettings.*` and mirror
// into local state so the inputs blur-persist.
const meta = {
  title: "Settings/AgentRuntime/Tabs/DefaultsTab",
  component: DefaultsTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAgentAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DefaultsTab>

export default meta
type Story = StoryObj<typeof meta>

// Library defaults (empty settings blob).
export const Default: Story = {}

// A configured runtime: acceptEdits mode, pinned model, thinking budget, brief.
export const Configured: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeConfiguredDefaults() })
  },
}
