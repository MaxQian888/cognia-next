import type { Meta, StoryObj } from "@storybook/nextjs"

import { RoutingTestPanel } from "./routing-test-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeModelMapping,
  makeProviderSettingsMap,
  makeRoutingConfig,
} from "@/lib/storybook/fixtures/settings-provider"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// "What would the next send pick?" preview. Builds a routing engine from the
// full settings and resolves a typed alias on demand. The result region only
// appears after the user runs a preview (Enter / button); the default render is
// the alias input + run button.
const meta = {
  title: "Settings/Provider/Routing/RoutingTestPanel",
  component: RoutingTestPanel,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({
        providerSettings: makeProviderSettingsMap(),
        modelMappings: [
          makeModelMapping({ alias: "fast" }),
          makeModelMapping({ alias: "balanced" }),
        ],
        routingConfig: makeRoutingConfig(),
      }),
    })
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RoutingTestPanel>

export default meta
type Story = StoryObj<typeof meta>

// Default — type an alias and run the preview to see the resolved provider:model.
export const Default: Story = {}

// No mappings configured — previewing any alias falls through to "no match".
export const NoMappings: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAppSettings({
        providerSettings: makeProviderSettingsMap(),
        modelMappings: [],
        routingConfig: makeRoutingConfig(),
      }),
    })
  },
}
