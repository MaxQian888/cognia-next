import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ComponentProps } from "react"

import { ProviderSettings } from "./provider-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeProviderSettingsMap,
  makeCustomProviderSettings,
} from "@/lib/storybook/fixtures/settings-provider"
import type { AppSettings } from "@cognia/agent-config-types"

// Full provider-management surface: sidebar (all built-in catalog providers +
// customs) and a detail panel of Config / Models / Cost / Advanced tabs. Reads
// the NESTED `settings.{providerSettings,customProviders,defaultProvider}` via
// `useProviderSettings`. The first provider is auto-selected on mount.
const meta = {
  title: "Settings/Provider/ProviderSettings",
  component: ProviderSettings,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[720px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProviderSettings>

export default meta
type Story = StoryObj<ComponentProps<typeof ProviderSettings>>

// No saved configuration — every catalog provider shows as not-configured.
export const Default: Story = {}

// Several configured built-in providers (varied health) drive the sidebar
// status badges and the selected provider's detail panel.
export const Configured: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: {
        providerSettings: makeProviderSettingsMap(),
        defaultProvider: "openai",
      } as AppSettings,
    })
  },
}

// Built-ins plus a user-defined custom gateway listed in the sidebar.
export const WithCustomProvider: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: {
        providerSettings: makeProviderSettingsMap(),
        defaultProvider: "openai",
        customProviders: [
          makeCustomProviderSettings({ id: "my-gateway", customName: "My Gateway" }),
        ],
      } as AppSettings,
    })
  },
}
