import type { Meta, StoryObj } from "@storybook/nextjs"

import { CLIProxyAPISettings } from "./cliproxyapi-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeUserProviderSettings,
  makeDiscoveredModel,
} from "@/lib/storybook/fixtures/settings-provider"
import type { UserProviderSettings } from "@cognia/provider-types/provider"

// CLIProxyAPI server panel. Reads the FLAT `providerSettings.cliproxyapi` row
// and renders NOTHING unless that provider is enabled, so every story seeds an
// enabled row. Connection auto-test runs on mount (network call no-ops here).
const seed =
  (over: Partial<UserProviderSettings> = {}) =>
  () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      providerSettings: {
        cliproxyapi: makeUserProviderSettings({
          providerId: "cliproxyapi",
          enabled: true,
          apiKey: "sk-cliproxy-0123456789abcdef",
          ...over,
        }),
      },
    })
  }

const meta = {
  title: "Settings/Provider/CLIProxyAPISettings",
  component: CLIProxyAPISettings,
  parameters: { layout: "padded" },
  beforeEach: seed(),
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CLIProxyAPISettings>

export default meta
type Story = StoryObj<typeof meta>

// Enabled provider, no models fetched yet — status / WebUI / config cards.
export const Default: Story = {}

// A populated discovered-models list under the "Available Models" section.
export const WithDiscoveredModels: Story = {
  beforeEach: seed({
    discoveredModels: [
      makeDiscoveredModel({ id: "gpt-4.1", name: "GPT-4.1" }),
      makeDiscoveredModel({ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }),
      makeDiscoveredModel({ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }),
    ],
  }),
}
