import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillMarketplaceDetailContent } from "./skill-marketplace-detail-content"
import { makeMarketplaceItem, makeAudit, makeFileTree } from "@/lib/storybook/fixtures/skills"

// Props-driven detail pane. On mount it lazily fetches the README over the
// network; in Storybook that request fails and the readme area shows its error
// state — the rest of the pane (header, badges, file manifest, actions) renders
// from props as normal.
const meta = {
  title: "Skills/SkillMarketplaceDetailContent",
  component: SkillMarketplaceDetailContent,
  parameters: { layout: "fullscreen" },
  args: {
    item: makeMarketplaceItem(),
    installed: false,
    installing: false,
    onInstall: fn(),
    onUninstall: fn(),
    onNeedAudit: fn(),
    onNeedFileTree: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[600px] max-w-2xl border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillMarketplaceDetailContent>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Installed: Story = {
  args: { installed: true },
}

export const Installing: Story = {
  args: { installing: true },
}

export const WithAuditAndFiles: Story = {
  args: {
    audit: makeAudit(),
    fileTree: makeFileTree(),
  },
}
