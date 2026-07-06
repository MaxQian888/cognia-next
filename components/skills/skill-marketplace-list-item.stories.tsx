import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillMarketplaceListItem } from "./skill-marketplace-list-item"
import { makeMarketplaceItem } from "@/lib/storybook/fixtures/skills"

// Pure props-only — a Browse-list row for a marketplace item.
const meta = {
  title: "Skills/SkillMarketplaceListItem",
  component: SkillMarketplaceListItem,
  parameters: { layout: "padded" },
  args: {
    item: makeMarketplaceItem(),
    installed: false,
    active: false,
    onSelect: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillMarketplaceListItem>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Active: Story = {
  args: { active: true },
}

export const Installed: Story = {
  args: { installed: true },
}

export const NoDownloads: Story = {
  args: {
    item: makeMarketplaceItem({ downloads: undefined, author: undefined, repository: "octo/repo" }),
  },
}
