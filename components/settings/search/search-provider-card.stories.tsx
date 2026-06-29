import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SearchProviderCard } from "./search-provider-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeSearchAppSettings, makeProviders } from "@/lib/storybook/fixtures/settings-search"

// `SearchProviderCard` is a collapsible per-provider row. Expand/collapse, key
// visibility and the connection-test state are controlled via props, while the
// API key / priority / enabled values come from `useSettingsStore`. Stories seed
// the store so the configured vs unconfigured branches are visible.
const meta = {
  title: "Settings/Search/SearchProviderCard",
  component: SearchProviderCard,
  parameters: { layout: "padded" },
  args: {
    providerId: "tavily",
    isExpanded: false,
    showKey: false,
    testState: { testing: false, result: null },
    onToggleExpand: fn(),
    onToggleKey: fn(),
    onTestConnection: fn(),
  },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeSearchAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchProviderCard>

export default meta
type Story = StoryObj<typeof meta>

// Collapsed, no API key → muted header with the enable switch disabled.
export const Collapsed: Story = {}

export const ExpandedUnconfigured: Story = {
  args: { isExpanded: true },
}

// Configured + enabled → "Active" badge, key field populated, priority controls.
export const ExpandedConfigured: Story = {
  args: { isExpanded: true },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        searchProviders: makeProviders({
          tavily: { apiKey: "tvly-demo-key-1234567890", enabled: true, priority: 1 },
        }),
      }),
    })
  },
}

export const Testing: Story = {
  args: { isExpanded: true, testState: { testing: true, result: null } },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        searchProviders: makeProviders({
          tavily: { apiKey: "tvly-demo-key-1234567890", enabled: true },
        }),
      }),
    })
  },
}

export const ConnectionSuccess: Story = {
  args: { isExpanded: true, testState: { testing: false, result: "success" } },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        searchProviders: makeProviders({
          tavily: { apiKey: "tvly-demo-key-1234567890", enabled: true },
        }),
      }),
    })
  },
}

export const ConnectionError: Story = {
  args: { isExpanded: true, testState: { testing: false, result: "error" } },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        searchProviders: makeProviders({
          tavily: { apiKey: "tvly-demo-key-1234567890", enabled: true },
        }),
      }),
    })
  },
}

// Google exposes an extra "cx" (Programmable Search Engine ID) field.
export const GoogleProvider: Story = {
  args: { providerId: "google", isExpanded: true, showKey: true },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        searchProviders: makeProviders({
          google: { apiKey: "AIzaDemoKey1234567890", cx: "0123456789abcdef", enabled: true },
        }),
      }),
    })
  },
}
