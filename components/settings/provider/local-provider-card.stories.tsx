import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { LocalProviderCard } from "./local-provider-card"

type TestResult = { success: boolean; message: string; latency?: number }

// Pure component: a configuration card for an OpenAI-compatible local engine.
// All connection state is prop-driven; `onTestConnection` is an async callback
// whose result is shown inline. `providerId` must be a `LocalProviderName`.
const meta = {
  title: "Settings/Provider/LocalProviderCard",
  component: LocalProviderCard,
  parameters: { layout: "padded" },
  args: {
    providerId: "ollama",
    enabled: true,
    baseUrl: "http://localhost:11434",
    isConnected: true,
    isLoading: false,
    version: "0.5.4",
    modelsCount: 7,
    latency: 38,
    onToggle: fn(),
    onBaseUrlChange: fn(),
    onTestConnection: fn(
      async (): Promise<TestResult> => ({ success: true, message: "Connected", latency: 38 })
    ),
    onManageModels: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LocalProviderCard>
export default meta
type Story = StoryObj<typeof meta>

export const Connected: Story = {}

export const Disconnected: Story = {
  args: {
    isConnected: false,
    version: undefined,
    modelsCount: undefined,
    latency: undefined,
    error: "Connection refused on http://localhost:11434",
    onTestConnection: fn(
      async (): Promise<TestResult> => ({ success: false, message: "Connection refused" })
    ),
  },
}

export const Disabled: Story = {
  args: { enabled: false, isConnected: false },
}

export const Compact: Story = {
  args: { compact: true, providerId: "lmstudio", baseUrl: "http://localhost:1234/v1" },
}

export const LmStudio: Story = {
  args: {
    providerId: "lmstudio",
    baseUrl: "http://localhost:1234/v1",
    version: "0.3.5",
    modelsCount: 3,
  },
}
