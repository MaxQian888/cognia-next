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
import type {
  CustomProviderSettings,
  ProviderUIPreferences,
  UserProviderSettings,
} from "@cognia/provider-types/provider"

function seedProviderStory(
  settings: AppSettings,
  providerUIPreferences: ProviderUIPreferences
): void {
  resetStore(useSettingsStore)

  const updateSettings = (updater: (current: AppSettings) => AppSettings) => {
    useSettingsStore.setState((state) => {
      const next = updater((state.settings ?? settings) as AppSettings)
      return {
        settings: next,
        defaultProvider: next.defaultProvider ?? "",
        providerSettings: next.providerSettings ?? {},
        customProviders: next.customProviders ?? [],
        providerUIPreferences: next.providerUIPreferences ?? providerUIPreferences,
      }
    })
  }

  seedStore(useSettingsStore, {
    loaded: true,
    settings,
    defaultProvider: settings.defaultProvider ?? "",
    providerSettings: settings.providerSettings ?? {},
    customProviders: settings.customProviders ?? [],
    providerUIPreferences,
    setProviderUIPreferences: async (patch) => {
      updateSettings((current) => ({
        ...current,
        providerUIPreferences: {
          ...providerUIPreferences,
          ...(current.providerUIPreferences ?? {}),
          ...patch,
        },
      }))
    },
    setProviderConfig: async (providerId, patch) => {
      updateSettings((current) => ({
        ...current,
        providerSettings: {
          ...(current.providerSettings ?? {}),
          [providerId]: {
            providerId,
            enabled: false,
            defaultModel: "",
            ...(current.providerSettings?.[providerId] ?? {}),
            ...patch,
          } satisfies UserProviderSettings,
        },
      }))
    },
    setDefaultProvider: async (providerId) => {
      updateSettings((current) => ({ ...current, defaultProvider: providerId }))
    },
    upsertCustomProvider: async (provider) => {
      updateSettings((current) => {
        const customProviders = [...(current.customProviders ?? [])]
        const index = customProviders.findIndex((entry) => entry.id === provider.id)
        if (index >= 0) customProviders[index] = provider
        else customProviders.push(provider)
        return { ...current, customProviders }
      })
    },
    removeCustomProvider: async (providerId) => {
      updateSettings((current) => ({
        ...current,
        customProviders: (current.customProviders ?? []).filter(
          (provider: CustomProviderSettings) => provider.id !== providerId
        ),
      }))
    },
    dismissProviderOnboarding: async () => {
      updateSettings((current) => ({ ...current, providerOnboardingDismissed: true }))
    },
  })
}

// Full provider-management surface: sidebar (all built-in catalog providers +
// customs) and a detail panel of Config / Models / Cost / Advanced tabs. Reads
// the NESTED `settings.{providerSettings,customProviders,defaultProvider}` via
// `useProviderSettings`. The first provider is auto-selected on mount.
const meta = {
  title: "Settings/Provider/ProviderSettings",
  component: ProviderSettings,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    seedProviderStory(
      {
        providerSettings: {},
        customProviders: [],
        providerUIPreferences: { selectedProviderId: "openai" },
      } as AppSettings,
      { selectedProviderId: "openai", statusFilter: "all", sortBy: "name" }
    )
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
    seedProviderStory(
      {
        providerSettings: makeProviderSettingsMap(),
        defaultProvider: "openai",
        providerUIPreferences: { selectedProviderId: "openai" },
      } as AppSettings,
      { selectedProviderId: "openai", statusFilter: "all", sortBy: "name" }
    )
  },
}

// Built-ins plus a user-defined custom gateway listed in the sidebar.
export const WithCustomProvider: Story = {
  beforeEach: () => {
    seedProviderStory(
      {
        providerSettings: makeProviderSettingsMap(),
        defaultProvider: "openai",
        customProviders: [
          makeCustomProviderSettings({ id: "my-gateway", customName: "My Gateway" }),
        ],
        providerUIPreferences: { selectedProviderId: "my-gateway" },
      } as AppSettings,
      {
        selectedProviderId: "my-gateway",
        statusFilter: "all",
        sortBy: "name",
      }
    )
  },
}

export const LocalProvider: Story = {
  beforeEach: () => {
    seedProviderStory(
      {
        providerSettings: {
          ollama: {
            providerId: "ollama",
            enabled: true,
            baseURL: "http://127.0.0.1:11434/v1",
            defaultModel: "llama3.2",
            discoveredModels: [{ id: "llama3.2", name: "Llama 3.2" }],
            verificationStatus: "verified",
          },
        },
        defaultProvider: "ollama",
        providerUIPreferences: { selectedProviderId: "ollama" },
      } as AppSettings,
      { selectedProviderId: "ollama", statusFilter: "all", sortBy: "name" }
    )
  },
}
