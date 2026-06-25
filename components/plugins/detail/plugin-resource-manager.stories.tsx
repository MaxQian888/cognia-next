import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginResourceManager } from "./plugin-resource-manager"

// Resource-manager card from the plugin detail pane — renders the configured
// rate-limit ceilings (from `lib/plugin/security/rate-limiter`, passed in as
// the `limits` prop) with a usage bar per category. Live usage counters come
// from `usePluginAnalytics` (a Dexie live query); without a backing IndexedDB
// in this Storybook the analytics overlay is empty, so every bar renders at
// `0 / limit`. The whole row matrix is still driven by the `limits` prop, and
// the empty-state (no limits configured) is its own story.

const RATE_LIMITS = [
  { key: "tool.invoke", limit: 100, windowMs: 60_000 },
  { key: "hook.dispatch", limit: 500, windowMs: 60_000 },
  { key: "network.fetch", limit: 60, windowMs: 60_000 },
  { key: "filesystem.write", limit: 200, windowMs: 60_000 },
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

// One row per configured limit. Usage shows 0 / limit here because the
// analytics live query has no backing store in Storybook.
export const WithLimits: Story = {}

// A single category — the minimal non-empty case.
export const SingleLimit: Story = {
  args: { limits: [{ key: "tool.invoke", limit: 100, windowMs: 60_000 }] },
}

// Empty `limits` → the GaugeIcon empty-state card.
export const NoLimits: Story = {
  args: { limits: [] },
}
