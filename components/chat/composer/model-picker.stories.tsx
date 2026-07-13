import type { Meta, StoryObj } from "@storybook/nextjs"

import { ModelPicker } from "./model-picker"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"

// Seed the settings store with a couple of enabled providers so the popover
// renders grouped, capability-annotated model lists. `collectModelOptions`
// always injects the built-in Anthropic catalog, so even an empty store yields
// a usable list — this just makes the grouping/search richer to demo.
const seedProviders = async () => {
  useSettingsStore.setState({
    settings: {
      defaultModel: "claude-sonnet-4-5",
      defaultProvider: "anthropic",
      providerSettings: {
        openai: {
          providerId: "openai",
          enabled: true,
          enabledModels: ["gpt-5", "o3"],
        },
      },
      customProviders: [],
    } as unknown as AppSettings,
  })
}

const session: ChatSession = {
  id: "sess-model-1",
  title: "Wire the model picker",
  model: "claude-sonnet-4-5",
  providerOverride: "anthropic",
} as ChatSession

const meta = {
  title: "Chat/Composer/ModelPicker",
  component: ModelPicker,
  parameters: { layout: "padded" },
  beforeEach: seedProviders,
} satisfies Meta<typeof ModelPicker>

export default meta
type Story = StoryObj<typeof meta>

// Active session → the trigger button is interactive (click to open the
// Popover + Command list of grouped providers/models).
export const Default: Story = {
  args: { session },
}

// Streaming in flight → the trigger is disabled.
export const Disabled: Story = {
  args: { session, disabled: true },
}

// No session yet (composer rendered between sessions) → renders a static,
// non-interactive chip instead of the popover trigger so layout doesn't shift.
export const NoSession: Story = {
  args: { session: null },
}
