import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginRecommendedSources } from "./recommended-sources"
import { sampleRecommendedSources } from "@/lib/storybook/fixtures/plugins"

// Curated marketplaces offered in the empty state, so a first-run user has
// somewhere to start instead of a sentence telling them what they lack.

const meta = {
  title: "Plugins/Marketplace/RecommendedSources",
  component: PluginRecommendedSources,
  args: {
    sources: sampleRecommendedSources(),
    addedIds: new Set<string>(),
    busyRepoRef: null,
    onAdd: fn(),
  },
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[26rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginRecommendedSources>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// One already saved.
export const PartiallyAdded: Story = {
  args: { addedIds: new Set(["cognia/plugins"]) },
}

// Add in flight.
export const Adding: Story = {
  args: { busyRepoRef: "cognia/community-plugins" },
}

// Nothing curated configured — renders nothing, so the caller falls back to
// its plain empty state. This is what ships until real repositories exist.
export const NoneConfigured: Story = {
  args: { sources: [] },
}
