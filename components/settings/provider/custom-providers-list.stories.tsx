import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { makeCustomProviderSettings } from "@/lib/storybook/fixtures/settings-provider"
import { CustomProvidersList } from "./custom-providers-list"

// Card listing user-defined (OpenAI-compatible) providers. Pure props: the
// providers map plus per-provider test result / message / in-flight maps and
// the action callbacks. Search filtering is internal to the component.

const PROVIDERS = {
  "custom-1": makeCustomProviderSettings({
    id: "custom-1",
    customName: "Together AI",
    baseURL: "https://api.together.xyz/v1",
    customModels: ["meta-llama/Llama-3-70b", "mistralai/Mixtral-8x7B"],
  }),
  "custom-2": makeCustomProviderSettings({
    id: "custom-2",
    customName: "Local Gateway",
    baseURL: "https://gateway.local/v1",
    enabled: false,
    customModels: ["gateway-large"],
  }),
  "custom-3": makeCustomProviderSettings({
    id: "custom-3",
    customName: "Stale Proxy",
    baseURL: "https://proxy.example.com/v1",
    verificationStatus: "stale",
    customModels: ["proxy-default"],
  }),
}

const meta = {
  title: "Settings/Provider/CustomProvidersList",
  component: CustomProvidersList,
  parameters: { layout: "padded" },
  args: {
    providers: PROVIDERS,
    testResults: {},
    testMessages: {},
    testingProviders: {},
    onTestProvider: fn(),
    onEditProvider: fn(),
    onToggleProvider: fn(),
    onAddProvider: fn(),
    onQuickAdd: fn(),
  },
} satisfies Meta<typeof CustomProvidersList>

export default meta
type Story = StoryObj<typeof meta>

// Three providers in mixed enabled/stale states.
export const Populated: Story = {}

// One provider mid-test, one passed, one failed.
export const TestStates: Story = {
  args: {
    testingProviders: { "custom-1": true },
    testResults: { "custom-2": "success", "custom-3": "error" },
    testMessages: {
      "custom-2": "Connected — 12 models available",
      "custom-3": "401 Unauthorized — check the API key",
    },
  },
}

// Empty state — no custom providers configured yet.
export const Empty: Story = {
  args: {
    providers: {},
  },
}

// A search query that matches nothing in the list.
export const NoSearchMatch: Story = {
  args: {
    searchQuery: "zzz-no-match",
  },
}
