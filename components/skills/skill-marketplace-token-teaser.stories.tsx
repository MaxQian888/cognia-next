import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillMarketplaceTokenTeaser } from "./skill-marketplace-token-teaser"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// Reads `useSettingsStore` for the skills.sh token; renders the unlock card
// only while no token is configured. Reset the store to the unconfigured state.
const meta = {
  title: "Skills/SkillMarketplaceTokenTeaser",
  component: SkillMarketplaceTokenTeaser,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-xs">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillMarketplaceTokenTeaser>

export default meta
type Story = StoryObj<typeof meta>

export const Unconfigured: Story = {}
