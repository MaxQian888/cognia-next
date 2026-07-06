import type { Meta, StoryObj } from "@storybook/nextjs"

import { ProviderTabCodex } from "./provider-tab-codex"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"
import {
  DEFAULT_CODEX_SUBSCRIPTION_SETTINGS,
  type CodexSubscriptionSettings,
} from "@/types/subscription"

// `ProviderTabCodex` composes the (keyring-backed, empty-in-browser) account
// list + preset picker with two collapsible settings cards driven by
// `AppSettings.codexSubscriptionSettings` from the settings store. Reset the
// store between stories; seed the codex settings to drive the toggles/inputs.
function seedCodex(patch: Partial<CodexSubscriptionSettings>) {
  seedStore(useSettingsStore, {
    settings: {
      codexSubscriptionSettings: { ...DEFAULT_CODEX_SUBSCRIPTION_SETTINGS, ...patch },
    } as AppSettings,
  })
}

const meta = {
  title: "Settings/Subscription/ProviderTabCodex",
  component: ProviderTabCodex,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
} satisfies Meta<typeof ProviderTabCodex>

export default meta
type Story = StoryObj<typeof meta>

// Defaults: probe disabled, prefer-discovered/auto-refresh at their defaults.
export const Default: Story = {}

// Probe enabled — the cadence + warning-threshold inputs become editable.
export const ProbeEnabled: Story = {
  beforeEach: () =>
    seedCodex({ probeEnabled: true, preferDiscovered: true, autoRefreshNearExpiry: true }),
}
