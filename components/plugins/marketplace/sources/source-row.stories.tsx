import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginMarketplaceSourceRow } from "./source-row"
import { sampleMarketplaceSources } from "@/lib/storybook/fixtures/plugins"

// One saved source with its sync health. The error story is the state that had
// no UI at all before: `useGithubMarketplaceSources` collected these errors and
// nothing rendered them.

const [healthy, syncing, failed, never] = sampleMarketplaceSources()

const meta = {
  title: "Plugins/Marketplace/SourceRow",
  component: PluginMarketplaceSourceRow,
  args: {
    source: healthy,
    onRefresh: fn(),
    onRemove: fn(),
    onOpenRepo: fn(),
  },
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[26rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginMarketplaceSourceRow>

export default meta
type Story = StoryObj<typeof meta>

// Synced fine: plugin count and how long ago.
export const Healthy: Story = {}

// Catalog fetch in flight.
export const Syncing: Story = { args: { source: syncing } }

// Rate-limited / renamed / broken JSON — the message and a retry.
export const SyncFailed: Story = { args: { source: failed } }

// Added but never successfully synced (added offline, say).
export const NeverSynced: Story = { args: { source: never } }
