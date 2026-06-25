import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginMarketplaceModeBanner } from "./plugin-marketplace-mode-banner"

// Source-mode banner above the marketplace grid. Reads
// `usePluginMarketplaceStore.sourceState.mode`, but accepts a `mode` override
// (its test/preview hook) so these stories drive each mode deterministically
// without touching the store. `remote` renders nothing — the happy path stays
// visually quiet — so it's shown via a labelled placeholder.

const meta = {
  title: "Plugins/Marketplace/PluginMarketplaceModeBanner",
  component: PluginMarketplaceModeBanner,
  args: { mode: "demo" },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[480px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginMarketplaceModeBanner>

export default meta
type Story = StoryObj<typeof meta>

// Browsing a sample catalog — installs are simulated.
export const Demo: Story = { args: { mode: "demo" } }

// Network down — showing cached entries, install/update disabled.
export const Degraded: Story = { args: { mode: "degraded" } }

// `remote` renders null; show a placeholder so the story isn't blank.
export const Remote: Story = {
  args: { mode: "remote" },
  render: (args) => (
    <div>
      <PluginMarketplaceModeBanner {...args} />
      <p className="text-xs text-muted-foreground">
        (remote mode renders nothing — the banner only appears for demo/degraded)
      </p>
    </div>
  ),
}
