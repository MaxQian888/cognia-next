import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillMarketplaceDetail } from "./skill-marketplace-detail"
import { makeMarketplaceItem, makeAudit, makeFileTree } from "@/lib/storybook/fixtures/skills"

// Mobile Sheet wrapper around the detail content. It renders open; the inner
// README fetch fails harmlessly in Storybook (web).
const meta = {
  title: "Skills/SkillMarketplaceDetail",
  component: SkillMarketplaceDetail,
  parameters: { layout: "fullscreen" },
  args: {
    item: makeMarketplaceItem(),
    installed: false,
    installing: false,
    onClose: fn(),
    onInstall: fn(),
    onUninstall: fn(),
    onNeedAudit: fn(),
    onNeedFileTree: fn(),
  },
} satisfies Meta<typeof SkillMarketplaceDetail>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const InstalledWithExtras: Story = {
  args: {
    installed: true,
    audit: makeAudit(),
    fileTree: makeFileTree(),
  },
}
