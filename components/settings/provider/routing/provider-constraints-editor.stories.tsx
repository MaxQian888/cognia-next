import type { Meta, StoryObj } from "@storybook/nextjs"

import { ProviderConstraintsEditor } from "./provider-constraints-editor"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeProviderConstraint,
  makeProviderSettingsMap,
  makeRoutingConfig,
} from "@/lib/storybook/fixtures/settings-provider"
import type { ProviderConstraint } from "@cognia/provider-types/model-mapping"
import type { AppSettings } from "@cognia/agent-config-types"

// Per-provider constraint rows: daily budget (USD, advisory), RPM/TPM ceilings,
// enabled flag. Provider <Select> options come from configured providers; the
// rows themselves live on `settings.routingConfig.providerConstraints`.
const seedConstraints = (providerConstraints: ProviderConstraint[]) => () => {
  resetStore(useSettingsStore)
  seedStore(useSettingsStore, {
    settings: {
      providerSettings: makeProviderSettingsMap(),
      routingConfig: makeRoutingConfig({ providerConstraints }),
    } as AppSettings,
  })
}

const meta = {
  title: "Settings/Provider/Routing/ProviderConstraintsEditor",
  component: ProviderConstraintsEditor,
  parameters: { layout: "padded" },
  beforeEach: seedConstraints([]),
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProviderConstraintsEditor>

export default meta
type Story = StoryObj<typeof meta>

// No constraints yet — empty hint + add button.
export const Empty: Story = {}

// Two configured constraint rows in varied states.
export const Populated: Story = {
  beforeEach: seedConstraints([
    makeProviderConstraint({
      providerId: "openai",
      dailyCostBudget: 25,
      maxRequestsPerMinute: 60,
      maxTokensPerMinute: 200_000,
      enabled: true,
    }),
    makeProviderConstraint({
      providerId: "anthropic",
      dailyCostBudget: 50,
      maxRequestsPerMinute: undefined,
      maxTokensPerMinute: undefined,
      enabled: false,
    }),
  ]),
}
