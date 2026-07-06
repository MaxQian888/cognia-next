import type { Meta, StoryObj } from "@storybook/nextjs"
import { ProviderHealthStatus } from "./provider-health-status"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeUserProviderSettings } from "@/lib/storybook/fixtures/settings-provider"

// Store-reading component: derives a health badge from the flat
// `providerSettings[providerId]` slice of `useSettingsStore`. Each story seeds
// that flat field directly (seedStore does a shallow top-level merge and does
// NOT run the store's derive wrapper).
function seed(settings: Parameters<typeof makeUserProviderSettings>[0]) {
  resetStore(useSettingsStore)
  seedStore(useSettingsStore, {
    providerSettings: { openai: makeUserProviderSettings({ providerId: "openai", ...settings }) },
  })
}

const meta = {
  title: "Settings/Provider/ProviderHealthStatus",
  component: ProviderHealthStatus,
  args: { providerId: "openai" },
} satisfies Meta<typeof ProviderHealthStatus>
export default meta
type Story = StoryObj<typeof meta>

export const Healthy: Story = {
  beforeEach: () => seed({ verificationStatus: "verified", healthStatus: "healthy" }),
}

export const Degraded: Story = {
  beforeEach: () => seed({ verificationStatus: "stale" }),
}

export const ErrorState: Story = {
  beforeEach: () => seed({ verificationStatus: "unverified", healthStatus: "error" }),
}

export const Unknown: Story = {
  // No apiKey and no baseURL → "unknown".
  beforeEach: () =>
    seed({ verificationStatus: "unverified", healthStatus: "unknown", apiKey: undefined }),
}

export const Compact: Story = {
  args: { compact: true },
  beforeEach: () => seed({ verificationStatus: "verified", healthStatus: "healthy" }),
}
