import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginSourcePreviewCard } from "./source-preview-card"
import { sampleSourcePreview } from "@/lib/storybook/fixtures/plugins"

// The catalog preview shown before a source is saved: identity, plugin list,
// and the not-reviewed notice.

const meta = {
  title: "Plugins/Marketplace/SourcePreviewCard",
  component: PluginSourcePreviewCard,
  args: {
    preview: sampleSourcePreview(),
    adding: false,
    onAdd: fn(),
    onCancel: fn(),
    onOpenRepo: fn(),
  },
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginSourcePreviewCard>

export default meta
type Story = StoryObj<typeof meta>

// Twelve plugins — five rows plus the "…and 7 more" expander.
export const Default: Story = {}

// Short catalog: no expander.
export const FewPlugins: Story = {
  args: {
    preview: sampleSourcePreview({ entries: sampleSourcePreview().entries.slice(0, 3) }),
  },
}

// A catalog that declares no plugins yet.
export const EmptyCatalog: Story = {
  args: { preview: sampleSourcePreview({ entries: [], owner: undefined }) },
}

// Already saved — the add CTA is disabled and the state is named.
export const AlreadyAdded: Story = {
  args: { preview: sampleSourcePreview({ alreadyAdded: true }) },
}

// Add in flight.
export const Adding: Story = {
  args: { adding: true },
}
