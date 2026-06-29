import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ProviderConfigTab, type TestResult } from "./provider-config-tab"
import { makeUserProviderSettings } from "@/lib/storybook/fixtures/settings-provider"

// Pure config tab: API key + base URL + default model + connection status +
// optional key-rotation section. All persistence is via callback props.
const PROVIDER_MODELS = [
  { id: "gpt-4.1", name: "GPT-4.1" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
  { id: "o3", name: "o3" },
]

const meta = {
  title: "Settings/Provider/ProviderConfigTab",
  component: ProviderConfigTab,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    providerId: "openai",
    settings: makeUserProviderSettings({ providerId: "openai" }),
    providerModels: PROVIDER_MODELS,
    providerDashboardUrl: "https://platform.openai.com/api-keys",
    providerDocsUrl: "https://platform.openai.com/docs",
    onApiKeyChange: fn(),
    onBaseURLChange: fn(),
    onDefaultModelChange: fn(),
    onTestConnection: fn(async (): Promise<TestResult> => ({ success: true, latency: 120 })),
  },
} satisfies Meta<typeof ProviderConfigTab>

export default meta
type Story = StoryObj<typeof meta>

// Configured key, no test run yet — the standalone Test button is shown.
export const Default: Story = {}

// A successful connection test (green status card with latency + timestamp).
export const Connected: Story = {
  args: {
    testResult: { success: true, latency: 95, testedAt: Date.UTC(2026, 5, 28, 10, 30) },
  },
}

// A failed connection test (destructive status card with the error message).
export const ConnectionFailed: Story = {
  args: {
    testResult: { success: false, error: "401 Unauthorized — invalid API key" },
  },
}

// Verification succeeded only partially (amber "limited" status card).
export const LimitedVerification: Story = {
  args: {
    testResult: {
      success: true,
      outcome: "limited",
      error: "Key works but the /models endpoint is unavailable.",
    },
  },
}

// A test is in flight — the Test button shows a spinner and is disabled.
export const Testing: Story = {
  args: { isTesting: true },
}

// No API key entered yet — the standalone Test button is disabled.
export const Unconfigured: Story = {
  args: {
    settings: makeUserProviderSettings({ providerId: "openai", apiKey: undefined, enabled: false }),
  },
}

// Key-rotation section enabled with a populated key pool.
export const WithKeyRotation: Story = {
  args: {
    settings: makeUserProviderSettings({
      providerId: "openai",
      apiKeys: [
        "sk-rotation-key-aaaaaaaaaaaa1111",
        "sk-rotation-key-bbbbbbbbbbbb2222",
        "sk-rotation-key-cccccccccccc3333",
      ],
      apiKeyRotationEnabled: true,
      apiKeyRotationStrategy: "round-robin",
    }),
    onAddApiKey: fn(),
    onRemoveApiKey: fn(),
    onReorderApiKeys: fn(),
    onToggleRotation: fn(),
    onRotationStrategyChange: fn(),
  },
}

// Provider with no published model list — the default-model select is hidden.
export const NoModelList: Story = {
  args: { providerModels: [] },
}
