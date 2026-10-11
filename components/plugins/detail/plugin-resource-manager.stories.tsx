import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginResourceManager } from "./plugin-resource-manager"

// Rate limits from the plugin detail pane's Data tab — the token buckets
// `lib/plugin/security/rate-limiter` keeps for every plugin (passed in as the
// `limits` prop), phrased as a localized rate plus the burst allowance. An
// all-time count appears only where `usePluginAnalytics` (a Dexie live query)
// has a counter under the operation's key; without a backing IndexedDB in this
// Storybook there are none, so each row shows just the rule.

const RATE_LIMITS = [
  { key: "network:fetch", limit: 60, windowMs: 60_000, burst: 60 },
  { key: "shell:execute", limit: 12, windowMs: 60_000, burst: 10 },
  { key: "fs:read", limit: 120, windowMs: 60_000, burst: 120 },
  { key: "ai:chat", limit: 12, windowMs: 60_000, burst: 20 },
]

const meta = {
  title: "Plugins/Detail/PluginResourceManager",
  component: PluginResourceManager,
  args: { pluginId: "com.acme.web-tools", limits: RATE_LIMITS },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[480px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginResourceManager>

export default meta
type Story = StoryObj<typeof meta>

// One row per bucket.
export const WithLimits: Story = {}

// A single category — the minimal case.
export const SingleLimit: Story = {
  args: { limits: [{ key: "network:fetch", limit: 60, windowMs: 60_000, burst: 60 }] },
}

// Phone-drawer width: rule and key stack instead of sharing a row.
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="w-[300px]">
        <Story />
      </div>
    ),
  ],
}
