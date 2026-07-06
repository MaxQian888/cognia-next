import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { OAuthLoginButton } from "./oauth-login-button"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeUserProviderSettings } from "@/lib/storybook/fixtures/settings-provider"
import type { UserProviderSettings } from "@cognia/provider-types/provider"

// Store-reading component: reads the flat `providerSettings[providerId]` slice
// of `useSettingsStore` and the provider catalog to decide its label. Only
// renders for providers with `supportsOAuth` (e.g. openrouter); otherwise
// returns null. Each story seeds the flat `providerSettings` field directly.
const HOUR = 60 * 60 * 1000

function seed(over?: Partial<UserProviderSettings>) {
  resetStore(useSettingsStore)
  const providerSettings: Record<string, UserProviderSettings> = over
    ? {
        openrouter: makeUserProviderSettings({ providerId: "openrouter", ...over }),
      }
    : {}
  seedStore(useSettingsStore, { providerSettings })
}

const meta = {
  title: "Settings/Provider/OAuthLoginButton",
  component: OAuthLoginButton,
  args: {
    providerId: "openrouter",
    onSuccess: fn(),
    onError: fn(),
  },
} satisfies Meta<typeof OAuthLoginButton>
export default meta
type Story = StoryObj<typeof meta>

export const NotConnected: Story = {
  beforeEach: () => seed(),
}

export const Connected: Story = {
  beforeEach: () =>
    seed({
      apiKey: "sk-or-connected",
      oauthConnected: true,
      oauthExpiresAt: Date.now() + 30 * 24 * HOUR,
    }),
}

export const ExpiringSoon: Story = {
  beforeEach: () =>
    seed({
      apiKey: "sk-or-connected",
      oauthConnected: true,
      oauthExpiresAt: Date.now() + 6 * HOUR,
    }),
}

export const Expired: Story = {
  beforeEach: () =>
    seed({
      apiKey: "sk-or-connected",
      oauthConnected: true,
      oauthExpiresAt: Date.now() - HOUR,
    }),
}

// Non-OAuth provider → component renders nothing.
export const UnsupportedProviderRendersNothing: Story = {
  args: { providerId: "openai" },
  beforeEach: () => seed(),
}
